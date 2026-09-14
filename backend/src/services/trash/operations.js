/**
 * Putting an entry in the trash, taking it out, and letting it go.
 *
 * Each operation writes what it is about to do before touching the disk, and
 * confirms afterwards:
 *
 *   trash    row `entering`, description beside it, rename into the zone, `trashed`
 *   restore  row `restoring` with its destination, rename out, row removed
 *   extract  row `extracting` with its destination, one entry from inside a
 *            deleted folder renamed out, what is left measured, `trashed`
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

const lstatOrNull = async (absolutePath) => {
  try {
    return await fsp.lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

/** The longest path inside a deleted folder accepted, in characters. */
const MAX_ENTRY_PATH = 4096;

/**
 * The segments of a path inside an item, or null when it is not one: relative,
 * separated by `/`, with no empty, `.` or `..` segment. A path that could climb
 * out of the item is refused before anything looks at the disk.
 */
const entrySegments = (entryPath) => {
  if (typeof entryPath !== 'string' || entryPath.length > MAX_ENTRY_PATH) return null;
  if (entryPath.includes('\0')) return null;
  if (entryPath === '') return [];
  const segments = entryPath.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    ? segments
    : null;
};

/**
 * Walk from an item's content to an entry inside it, one segment at a time and
 * through real directories only. A symbolic link inside a deleted folder is an
 * entry like any other — listed, and restored as the link it is — but nothing
 * is ever reached through it, so no listing or restore can be led out of the
 * item.
 */
const walkInside = async (payload, segments) => {
  let current = payload;
  for (const segment of segments) {
    // eslint-disable-next-line no-await-in-loop
    const stats = await lstatOrNull(current);
    if (!stats?.isDirectory()) return null;
    current = path.join(current, segment);
  }
  const stats = await lstatOrNull(current);
  return stats ? { absolutePath: current, stats } : null;
};

/**
 * Make the folder something is restored into, and make sure it is inside the
 * zone's own tree — on the resolved path as well as the written one, before
 * and after creating it. A folder replaced by a symbolic link since the
 * deletion must not send a restore, or the folders recreated on its way,
 * somewhere else.
 *
 * @returns {Promise<null | {status: 'blocked', reason: string}>} null once ready
 */
const prepareDestination = async (zone, parent) => {
  const invalid = { status: 'blocked', reason: 'invalid-destination' };
  const inTree = (root, candidate) =>
    zones.isWithin(root, candidate) && !zones.isWithin(zones.zoneDirectory(root), candidate);
  const resolvesInTree = async (candidate) => {
    try {
      const [root, resolved] = await Promise.all([
        fsp.realpath(zone.root),
        fsp.realpath(candidate),
      ]);
      return inTree(root, resolved);
    } catch {
      return false;
    }
  };

  if (!inTree(zone.root, parent)) return invalid;

  // The deepest folder that already exists is where a link could stand.
  let existing = parent;
  // eslint-disable-next-line no-await-in-loop
  while (existing !== zone.root && !(await lstatOrNull(existing))) {
    existing = path.dirname(existing);
  }
  if (!(await resolvesInTree(existing))) return invalid;

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
  return (await resolvesInTree(parent)) ? null : invalid;
};

/** An item whose content has gone: its row and description removed, the loss recorded. */
const recordLost = async (db, zone, item, sidecar) => {
  store.deleteItem(db, item.id);
  store.insertEvent(db, { zoneId: zone.id, itemId: item.id, itemName: item.name, kind: 'lost' });
  await fsp.rm(sidecar, { force: true });
  return { status: 'lost' };
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
    if (!(await exists(payload))) return recordLost(db, zone, item, sidecar);

    const parent = path.dirname(item.originalPath);
    const refused = await prepareDestination(zone, parent);
    if (refused) return refused;

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

const LIST_BATCH = 64;

const directoriesFirst = (left, right) => {
  const leftIsDirectory = left.kind === 'directory';
  if (leftIsDirectory !== (right.kind === 'directory')) return leftIsDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
};

/**
 * What a deleted folder holds at a path inside it: each entry's name, kind,
 * size for a file, and when it last changed. A symbolic link is listed as the
 * link it is, never followed.
 *
 * @returns {Promise<{status: 'listed', item: object, entries: object[]} |
 *   {status: 'missing'|'invalid-path'|'not-directory'} |
 *   {status: 'unavailable', reason: string}>}
 */
const listEntries = async (itemId, entryPath = '') => {
  const segments = entrySegments(entryPath);
  if (!segments) return { status: 'invalid-path' };
  const db = await getDb();
  const item = store.getItem(db, itemId);
  // An entry on its way out is still a folder worth looking into.
  if (!item || !['trashed', 'extracting'].includes(item.state)) return { status: 'missing' };

  const zone = store.getZone(db, item.zoneId);
  const inspection = zone ? await zones.inspectZone(zone) : { reason: 'missing' };
  if (!inspection.available) return { status: 'unavailable', reason: inspection.reason };

  const { payload } = confinedPaths(zone, item.id);
  const found = await walkInside(payload, segments);
  if (!found) return { status: 'missing' };
  if (!found.stats.isDirectory()) return { status: 'not-directory' };

  const names = await fsp.readdir(found.absolutePath);
  const entries = [];
  for (let index = 0; index < names.length; index += LIST_BATCH) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await Promise.all(
      names.slice(index, index + LIST_BATCH).map(async (name) => {
        const stats = await lstatOrNull(path.join(found.absolutePath, name));
        if (!stats) return null;
        let kind = 'file';
        if (stats.isDirectory()) kind = 'directory';
        else if (stats.isSymbolicLink()) kind = 'symlink';
        return {
          name,
          kind,
          size: stats.isFile() ? stats.size : null,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
    );
    entries.push(...batch.filter(Boolean));
  }
  entries.sort(directoriesFirst);
  return { status: 'listed', item, entries };
};

/**
 * Put one entry from inside a deleted folder back where it was: under the
 * folder's original path, at the same place inside it. Folders on the way that
 * have gone since are recreated; a name taken since gets a suffix; nothing is
 * ever replaced. The rest of the folder stays in the trash, and is measured
 * again so its recorded size stays the size on disk.
 *
 * Nothing is recorded per entry. The folder's own record is enough: the entry
 * at `<id>/drafts/v2.txt` in the trash was at `<original path>/drafts/v2.txt`.
 *
 * @returns {Promise<{status: 'restored', item: object, kind: string, size: number,
 *   restorePath: string, renamed: boolean} |
 *   {status: 'missing'|'busy'|'lost'|'invalid-path'} |
 *   {status: 'unavailable'|'blocked', reason: string}>}
 */
const restoreEntry = async (itemId, entryPath) => {
  const segments = entrySegments(entryPath);
  if (!segments?.length) return { status: 'invalid-path' };
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
    if (!(await exists(payload))) return recordLost(db, zone, item, sidecar);
    const found = await walkInside(payload, segments);
    if (!found) return { status: 'missing' };

    const destination = path.join(item.originalPath, ...segments);
    const parent = path.dirname(destination);
    const refused = await prepareDestination(zone, parent);
    if (refused) return refused;

    const kind = found.stats.isDirectory() ? 'directory' : 'file';
    const { bytes: size } = await measure(found.absolutePath);
    const wanted = path.basename(destination);
    const name = await findAvailableName(parent, wanted);
    const restorePath = path.join(parent, name);
    store.setItemState(db, item.id, 'extracting', { restorePath });
    await failpoints.hit('extract:after-intent', { id: item.id });

    try {
      // Checked again at the last moment: rename(2) replaces a file silently.
      if (await exists(restorePath)) {
        throw Object.assign(new Error('The destination was taken meanwhile.'), { code: 'EEXIST' });
      }
      await fsp.rename(found.absolutePath, restorePath);
    } catch (error) {
      store.setItemState(db, item.id, 'trashed');
      if (error?.code === 'EEXIST') return { status: 'busy' };
      throw error;
    }
    await failpoints.hit('extract:after-rename', { id: item.id });

    store.setItemSize(db, item.id, (await measure(payload)).bytes);
    store.setItemState(db, item.id, 'trashed');
    return {
      status: 'restored',
      item: store.getItem(db, item.id),
      kind,
      size,
      restorePath,
      renamed: name !== wanted,
    };
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
    } else if (row.state === 'extracting') {
      // Whether the entry left or not, what is still in the folder is what the
      // record must say: measured, and back in the trash.
      if (hasPayload) {
        store.setItemSize(db, row.id, (await measure(paths.payload)).bytes);
        store.setItemState(db, row.id, 'trashed');
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
  entrySegments,
  moveToTrash,
  restoreItem,
  listEntries,
  restoreEntry,
  purgeItem,
  forgetItem,
  recoverZone,
};
