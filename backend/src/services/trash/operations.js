/**
 * Putting an entry in the trash, taking it out, and letting it go.
 *
 * Each operation writes what it is about to do before touching the disk, and
 * confirms afterwards:
 *
 *   trash    row `entering`, description beside it, rename into the zone, `trashed`
 *   restore  row `restoring` with its destination, rename out, row removed
 *   purge    row `purging`, content removed, row removed
 *
 * A crash between two steps leaves a row in a passing state, and
 * `recoverZone` knows how to finish or undo each one by looking at where the
 * content actually is. The order is the one the freedesktop trash
 * specification requires — the description first, the move after — with the
 * case it leaves open decided here: a move that fails is undone.
 *
 * Nothing here decides who may do what, or when an item has been kept long
 * enough: that belongs to the service and the policy. These functions are
 * about keeping the disk and the books in agreement.
 */
const fsp = require('fs/promises');
const path = require('path');

const { generateId } = require('../../utils/ids');
const { findAvailableName } = require('../../utils/pathUtils');
const logger = require('../../utils/logger');
const { getDb } = require('../db');
const clock = require('./clock');
const failpoints = require('./failpoints');
const { admission } = require('./policy');
const store = require('./store');
const zones = require('./zones');

/** Items with an operation running in this process; recovery leaves them alone. */
const inflight = new Set();

/** The names the application gives items, as opposed to anything else found in a zone. */
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{15,}$/;

const exists = async (absolutePath) => {
  try {
    await fsp.lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
};

const MEASURE_BATCH = 64;

/** Bytes held under a path, and how many entries, never following a symbolic link. */
const measure = async (absolutePath) => {
  const stats = await fsp.lstat(absolutePath);
  if (!stats.isDirectory()) return { bytes: stats.isFile() ? stats.size : 0, entries: 1 };

  let bytes = 0;
  let entries = 1;
  const stack = [absolutePath];
  while (stack.length) {
    const current = stack.pop();
    let dirents;
    try {
      // eslint-disable-next-line no-await-in-loop
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries += dirents.length;
    const files = [];
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(child);
      else if (dirent.isFile()) files.push(child);
    }
    for (let index = 0; index < files.length; index += MEASURE_BATCH) {
      // eslint-disable-next-line no-await-in-loop
      const sizes = await Promise.all(
        files.slice(index, index + MEASURE_BATCH).map((file) =>
          fsp.lstat(file).then(
            (entry) => entry.size,
            () => 0
          )
        )
      );
      bytes += sizes.reduce((total, size) => total + size, 0);
    }
  }
  return { bytes, entries };
};

const describeForSidecar = (item) => ({
  version: 1,
  id: item.id,
  zoneId: item.zoneId,
  name: item.name,
  kind: item.kind,
  size: item.size,
  originalPath: item.originalPath,
  relativePath: item.relativePath,
  logicalPath: item.logicalPath || null,
  space: item.space || null,
  deletedBy: item.deletedBy || null,
  deletedByLabel: item.deletedByLabel || null,
  ownerUserId: item.ownerUserId || null,
  deletedAt: item.deletedAt,
});

const writeSidecar = (sidecarPath, item, flag = 'wx') =>
  fsp.writeFile(sidecarPath, `${JSON.stringify(describeForSidecar(item))}\n`, {
    flag,
    mode: 0o600,
  });

/**
 * The content of an item, checked to be where the application put it before
 * anything is removed or moved there. The id comes from the database; a row
 * someone edited must not be able to aim a removal outside the zone.
 */
const confinedPaths = (zone, itemId) => {
  if (typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId)) {
    const error = new Error(`Refusing to act on an item id that is not one: ${itemId}`);
    error.code = 'TRASH_ITEM_ID_INVALID';
    throw error;
  }
  const paths = zones.itemPaths(zone.root, itemId);
  const trashDirectory = zones.trashDirectory(zone.root);
  if (path.dirname(paths.payload) !== trashDirectory) {
    const error = new Error(`Refusing to act outside the trash of ${zone.root}`);
    error.code = 'TRASH_ITEM_ID_INVALID';
    throw error;
  }
  return paths;
};

/**
 * Move one existing entry into the trash of the zone it belongs to.
 *
 * @param {object} input
 * @param {string} input.absolutePath
 * @param {string} [input.logicalPath]   as the person deleting it addressed it
 * @param {string} [input.space]         volume | personal | share
 * @param {string} [input.deletedBy]     user id
 * @param {string} [input.deletedByLabel]
 * @param {string} [input.ownerUserId]   whose personal folder or share it came from
 * @param {object} [options]
 * @param {(root: string) => Promise<number>} [options.budgetFor]  bytes the zone may hold
 * @returns {Promise<{status: 'trashed', item: object} | {status: 'missing'} |
 *   {status: 'unavailable', reason: string, size?: number, budgetBytes?: number}>}
 */
const moveToTrash = async (input, { budgetFor } = {}) => {
  const absolutePath = path.resolve(input.absolutePath);
  const located = await zones.locateZoneRoot(absolutePath);
  if (!located.root) return { status: 'unavailable', reason: located.reason };
  const { root } = located;

  // Gone already — removed by someone else, or by the cleanup of a copy this
  // very deletion cancelled — is not a failure: there is nothing to keep.
  let stats;
  try {
    stats = await fsp.lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'missing' };
    throw error;
  }

  // Before anything is created: a zone must never appear on a disk the item
  // cannot be renamed onto.
  if (!(await zones.sameDevice(root, absolutePath))) {
    return { status: 'unavailable', reason: 'other-device' };
  }

  const kind = stats.isDirectory() ? 'directory' : 'file';
  const { bytes } = await measure(absolutePath);

  if (typeof budgetFor === 'function') {
    const budgetBytes = await budgetFor(root);
    if (admission({ size: bytes, budgetBytes }) === 'too-large') {
      return { status: 'unavailable', reason: 'too-large', size: bytes, budgetBytes };
    }
  }

  let zone;
  try {
    zone = await zones.ensureZone(root);
  } catch (error) {
    logger.warn({ err: error, root }, 'The trash zone could not be opened');
    return { status: 'unavailable', reason: 'zone-unwritable' };
  }

  const id = generateId();
  const { payload, sidecar } = zones.itemPaths(root, id);
  const db = await getDb();
  const record = {
    id,
    zoneId: zone.id,
    state: 'entering',
    name: path.basename(absolutePath),
    kind,
    size: bytes,
    originalPath: absolutePath,
    relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
    logicalPath: input.logicalPath,
    space: input.space,
    deletedBy: input.deletedBy,
    deletedByLabel: input.deletedByLabel,
    ownerUserId: input.ownerUserId,
    deletedAt: clock.nowIso(),
  };

  inflight.add(id);
  try {
    store.insertItem(db, record);
    await failpoints.hit('trash:after-row', { id });

    try {
      await writeSidecar(sidecar, record);
    } catch (error) {
      store.deleteItem(db, id);
      logger.warn({ err: error, root }, 'The trash could not describe an item');
      return { status: 'unavailable', reason: 'zone-unwritable' };
    }
    await failpoints.hit('trash:after-sidecar', { id });

    try {
      await fsp.rename(absolutePath, payload);
    } catch (error) {
      await fsp.rm(sidecar, { force: true }).catch(() => {});
      store.deleteItem(db, id);
      // Same device yet no rename: two mount points of one filesystem, which
      // the kernel treats as two. Still not something to copy.
      if (error?.code === 'EXDEV') return { status: 'unavailable', reason: 'other-device' };
      if (error?.code === 'ENOENT') return { status: 'missing' };
      throw error;
    }
    await failpoints.hit('trash:after-rename', { id });

    store.setItemState(db, id, 'trashed');
    return { status: 'trashed', item: store.getItem(db, id) };
  } finally {
    inflight.delete(id);
  }
};

/**
 * Put an item back where it was deleted from. A parent folder that has gone
 * since is recreated; a name taken since gets a suffix, as a copy would. It
 * never replaces anything.
 *
 * @returns {Promise<{status: 'restored', item, restorePath: string, renamed: boolean} |
 *   {status: 'missing'|'busy'|'lost'} | {status: 'unavailable', reason: string} |
 *   {status: 'blocked', reason: string}>}
 */
const restoreItem = async (itemId) => {
  if (inflight.has(itemId)) return { status: 'busy' };
  inflight.add(itemId);
  try {
    const db = await getDb();
    const item = store.getItem(db, itemId);
    if (!item) return { status: 'missing' };
    if (item.state !== 'trashed') return { status: 'busy' };

    const zone = store.getZone(db, item.zoneId);
    const inspection = zone ? await zones.inspectZone(zone) : { reason: 'missing' };
    if (!inspection.available) return { status: 'unavailable', reason: inspection.reason };

    const { payload, sidecar } = confinedPaths(zone, item.id);
    if (!(await exists(payload))) {
      store.deleteItem(db, item.id);
      store.insertEvent(db, {
        zoneId: zone.id,
        itemId: item.id,
        itemName: item.name,
        kind: 'lost',
      });
      await fsp.rm(sidecar, { force: true });
      return { status: 'lost' };
    }

    const parent = path.dirname(item.originalPath);
    if (
      !zones.isWithin(zone.root, parent) ||
      zones.isWithin(zones.zoneDirectory(zone.root), parent)
    ) {
      return { status: 'blocked', reason: 'invalid-destination' };
    }
    try {
      await fsp.mkdir(parent, { recursive: true });
      if (!(await fsp.stat(parent)).isDirectory())
        throw Object.assign(new Error(), { code: 'ENOTDIR' });
    } catch (error) {
      if (['EEXIST', 'ENOTDIR'].includes(error?.code)) {
        return { status: 'blocked', reason: 'destination-blocked' };
      }
      throw error;
    }

    const name = await findAvailableName(parent, item.name);
    const restorePath = path.join(parent, name);
    store.setItemState(db, item.id, 'restoring', { restorePath });
    await failpoints.hit('restore:after-intent', { id: item.id });

    try {
      // Checked again at the last moment: rename(2) replaces a file silently.
      if (await exists(restorePath)) {
        throw Object.assign(new Error('The destination was taken meanwhile.'), { code: 'EEXIST' });
      }
      await fsp.rename(payload, restorePath);
    } catch (error) {
      store.setItemState(db, item.id, 'trashed');
      if (error?.code === 'EEXIST') return { status: 'busy' };
      throw error;
    }
    await failpoints.hit('restore:after-rename', { id: item.id });

    store.deleteItem(db, item.id);
    await fsp.rm(sidecar, { force: true });
    return { status: 'restored', item, restorePath, renamed: name !== item.name };
  } finally {
    inflight.delete(itemId);
  }
};

/**
 * Remove an item for good. Resumes an item already `purging`, which is what a
 * purge interrupted by a crash leaves.
 *
 * @returns {Promise<{status: 'purged', item} | {status: 'missing'|'busy'} |
 *   {status: 'unavailable', reason: string}>}
 */
const purgeItem = async (itemId) => {
  if (inflight.has(itemId)) return { status: 'busy' };
  inflight.add(itemId);
  try {
    const db = await getDb();
    const item = store.getItem(db, itemId);
    if (!item) return { status: 'missing' };
    if (item.state !== 'trashed' && item.state !== 'purging') return { status: 'busy' };

    const zone = store.getZone(db, item.zoneId);
    const inspection = zone ? await zones.inspectZone(zone) : { reason: 'missing' };
    if (!inspection.available) return { status: 'unavailable', reason: inspection.reason };

    const { payload, sidecar } = confinedPaths(zone, item.id);
    store.setItemState(db, item.id, 'purging');
    await failpoints.hit('purge:after-intent', { id: item.id });

    await fsp.rm(payload, { recursive: true, force: true });
    await failpoints.hit('purge:after-remove', { id: item.id });

    store.deleteItem(db, item.id);
    await fsp.rm(sidecar, { force: true });
    return { status: 'purged', item };
  } finally {
    inflight.delete(itemId);
  }
};

/**
 * Drop the rows of items whose zone is gone for good, without touching any
 * disk. For an administrator who knows the disk is not coming back — the
 * maintenance never decides that on its own.
 */
const forgetItem = async (itemId) => {
  if (inflight.has(itemId)) return { status: 'busy' };
  const db = await getDb();
  const item = store.getItem(db, itemId);
  if (!item) return { status: 'missing' };
  store.deleteItem(db, item.id);
  store.insertEvent(db, {
    zoneId: item.zoneId,
    itemId: item.id,
    itemName: item.name,
    kind: 'forgotten',
  });
  return { status: 'forgotten', item };
};

const readSidecar = async (sidecarPath) => {
  try {
    return JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Bring a zone's books and its disk back into agreement.
 *
 * - An item left in a passing state is finished or undone, from where its
 *   content actually is.
 * - Content with no row — a database lost or restored from an older backup —
 *   is adopted, from its description when there is one. User data is never
 *   deleted for want of a record.
 * - A row whose content has gone is dropped and the loss recorded, unless so
 *   many have gone at once that the zone itself looks wrong, in which case
 *   nothing is dropped and the pass says so.
 * - A description with neither row nor content is the tail of a finished
 *   operation, and is removed.
 *
 * A zone whose marker is absent or names another zone is not touched at all.
 */
const recoverZone = async (zone, { breakerRatio = 0.2, breakerMinimum = 5 } = {}) => {
  const report = {
    zoneId: zone.id,
    skipped: false,
    finished: 0,
    undone: 0,
    adopted: 0,
    lost: 0,
    removedSidecars: 0,
    breaker: false,
  };
  const inspection = await zones.inspectZone(zone);
  if (!inspection.available) return { ...report, skipped: true, reason: inspection.reason };

  const db = await getDb();
  const trashDirectory = zones.trashDirectory(zone.root);
  let names;
  try {
    names = await fsp.readdir(trashDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    names = [];
  }
  const onDisk = new Set(names);
  const allRows = store.listItemsByZone(db, zone.id);
  const knownIds = new Set(allRows.map((row) => row.id));
  const rows = allRows.filter((row) => !inflight.has(row.id));

  const drop = async (row, sidecar, kind) => {
    store.deleteItem(db, row.id);
    await fsp.rm(sidecar, { force: true });
    if (kind) {
      store.insertEvent(db, { zoneId: zone.id, itemId: row.id, itemName: row.name, kind });
    }
  };

  for (const row of rows) {
    if (row.state === 'trashed') continue;
    let paths;
    try {
      paths = confinedPaths(zone, row.id);
    } catch {
      continue;
    }
    const hasPayload = onDisk.has(row.id);

    if (row.state === 'entering') {
      if (hasPayload) {
        if (!onDisk.has(`${row.id}.json`)) await writeSidecar(paths.sidecar, row, 'w');
        store.setItemState(db, row.id, 'trashed');
        report.finished += 1;
      } else if (await exists(row.originalPath)) {
        await drop(row, paths.sidecar);
        report.undone += 1;
      } else {
        await drop(row, paths.sidecar, 'lost');
        report.lost += 1;
      }
    } else if (row.state === 'restoring') {
      if (hasPayload) {
        store.setItemState(db, row.id, 'trashed');
        report.undone += 1;
      } else if (row.restorePath && (await exists(row.restorePath))) {
        await drop(row, paths.sidecar);
        report.finished += 1;
      } else {
        await drop(row, paths.sidecar, 'lost');
        report.lost += 1;
      }
    } else if (row.state === 'purging') {
      await fsp.rm(paths.payload, { recursive: true, force: true });
      await drop(row, paths.sidecar);
      report.finished += 1;
    }
  }

  const trashed = store
    .listItemsByZone(db, zone.id)
    .filter((row) => row.state === 'trashed' && !inflight.has(row.id));
  const vanished = trashed.filter((row) => !onDisk.has(row.id));
  if (
    vanished.length >= breakerMinimum &&
    trashed.length > 0 &&
    vanished.length / trashed.length > breakerRatio
  ) {
    report.breaker = true;
    store.insertEvent(db, {
      zoneId: zone.id,
      kind: 'breaker',
      detail: JSON.stringify({ vanished: vanished.length, trashed: trashed.length }),
    });
    logger.warn(
      { zoneId: zone.id, root: zone.root, vanished: vanished.length, trashed: trashed.length },
      'Too many trash items have lost their content at once; leaving the records alone'
    );
  } else {
    for (const row of vanished) {
      // eslint-disable-next-line no-await-in-loop
      await drop(row, zones.itemPaths(zone.root, row.id).sidecar, 'lost');
      report.lost += 1;
    }
  }

  for (const name of names) {
    if (name.endsWith('.json')) {
      const id = name.slice(0, -'.json'.length);
      if (!knownIds.has(id) && !onDisk.has(id) && ITEM_ID_PATTERN.test(id)) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(path.join(trashDirectory, name), { force: true });
        report.removedSidecars += 1;
      }
      continue;
    }
    if (knownIds.has(name) || !ITEM_ID_PATTERN.test(name)) continue;

    const { payload, sidecar } = zones.itemPaths(zone.root, name);
    // eslint-disable-next-line no-await-in-loop
    const described = onDisk.has(`${name}.json`) ? await readSidecar(sidecar) : null;
    // eslint-disable-next-line no-await-in-loop
    const stats = await fsp.lstat(payload).catch(() => null);
    if (!stats) continue;
    // eslint-disable-next-line no-await-in-loop
    const { bytes } = await measure(payload);

    const recoveredName = `recovered-${name.slice(0, 8)}`;
    const describedPath =
      typeof described?.originalPath === 'string' ? path.resolve(described.originalPath) : null;
    // A description pointing outside the zone's own tree is not believed: a
    // restore must never be aimed somewhere else by an edited file.
    const trustworthy =
      describedPath &&
      zones.isWithin(zone.root, describedPath) &&
      describedPath !== zone.root &&
      !zones.isWithin(zones.zoneDirectory(zone.root), describedPath);
    const originalPath = trustworthy ? describedPath : path.join(zone.root, recoveredName);

    const adopted = {
      id: name,
      zoneId: zone.id,
      state: 'trashed',
      name: trustworthy && described.name ? String(described.name) : recoveredName,
      kind: stats.isDirectory() ? 'directory' : 'file',
      size: bytes,
      originalPath,
      relativePath: path.relative(zone.root, originalPath).split(path.sep).join('/'),
      logicalPath: trustworthy ? described.logicalPath : null,
      space: trustworthy ? described.space : null,
      deletedBy: trustworthy ? described.deletedBy : null,
      deletedByLabel: trustworthy ? described.deletedByLabel : null,
      ownerUserId: trustworthy ? described.ownerUserId : null,
      deletedAt:
        trustworthy && !Number.isNaN(Date.parse(described.deletedAt))
          ? described.deletedAt
          : clock.nowIso(),
    };
    store.insertItem(db, adopted);
    // eslint-disable-next-line no-await-in-loop
    await writeSidecar(sidecar, adopted, 'w');
    store.insertEvent(db, {
      zoneId: zone.id,
      itemId: name,
      itemName: adopted.name,
      kind: 'adopted',
    });
    report.adopted += 1;
  }

  return report;
};

module.exports = {
  ITEM_ID_PATTERN,
  inflight,
  measure,
  moveToTrash,
  restoreItem,
  purgeItem,
  forgetItem,
  recoverZone,
};
