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
 *   restore or extract into a folder someone chose: the same rename on one
 *            disk; across two, row `copying`, a copy beside the destination,
 *            `copied` once it is whole, then named and the trash's copy removed
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

const { ZONE_DIRECTORY_NAME } = require('../../config/constants');
const { generateId } = require('../../utils/ids');
const { findAvailableName } = require('../../utils/pathUtils');
const logger = require('../../utils/logger');
const { moveNoReplace } = require('../../utils/placeWithoutOverwrite');
const { getDb } = require('../db');
const versionLifecycle = require('../versions/lifecycle');
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

/**
 * Whether two names are one regular file, linked under both.
 *
 * Content leaves the trash under a name nothing else holds (`moveNoReplace`):
 * a file is linked under its new name, then its old name removed. A crash in
 * between leaves the file under both names, which is told apart here from
 * anything else holding the destination — someone's file, or the empty file or
 * folder the move holds a name with where it cannot link — by the device and
 * inode both names share, and a link count that says so. Anything short of
 * that is not ours, and answers false.
 */
const linkedUnderBoth = async (first, second) => {
  const stat = (target) => fsp.lstat(target, { bigint: true }).catch(() => null);
  const [a, b] = await Promise.all([stat(first), stat(second)]);
  return Boolean(
    a?.isFile() &&
    b?.isFile() &&
    a.ino !== 0n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink >= 2n
  );
};

/**
 * Whether two names are one symbolic link, made again under the second.
 *
 * `moveNoReplace` moves a link by making it again under its new name, which
 * fails when the name is held, and then removing the old one. A crash in
 * between leaves both, holding the same text. The recovery passes the moment
 * the operation recorded its intent: a link with that text made before it is
 * someone else's. A restore still running made the second one a moment ago.
 */
const sameLinkUnderBoth = async (first, second, sinceIso = null) => {
  const [a, b] = await Promise.all([lstatOrNull(first), lstatOrNull(second)]);
  if (!a?.isSymbolicLink() || !b?.isSymbolicLink()) return false;
  if (sinceIso !== null) {
    const since = Date.parse(sinceIso);
    if (!Number.isFinite(since) || b.ctimeMs < since - PLACEHOLDER_CLOCK_MARGIN_MS) return false;
  }
  try {
    const [textA, textB] = await Promise.all([fsp.readlink(first), fsp.readlink(second)]);
    return textA === textB;
  } catch {
    return false;
  }
};

/**
 * The old name of a file just placed, when it stayed: `moveNoReplace` lets the
 * removal after the link fail quietly. Here that name is the trash's own
 * content, or its copy, which would otherwise be adopted as a second item or
 * left beside the destination. A failure now is thrown, with the operation
 * still in its passing state for the recovery to finish.
 */
const dropOldName = async (source, target) => {
  if ((await linkedUnderBoth(source, target)) || (await sameLinkUnderBoth(source, target))) {
    await fsp.unlink(source);
  }
};

// Filesystems keep times to the second at worst, and the record's clock and the
// filesystem's are the same one.
const PLACEHOLDER_CLOCK_MARGIN_MS = 2000;

/**
 * The empty file or folder a move held its destination with, when a crash
 * stopped it before the rename.
 *
 * For a folder, and for a file where there are no hard links, `moveNoReplace`
 * creates the destination empty and renames the content over it. A crash in
 * between leaves that empty entry beside content still in the trash, under the
 * name the restore was going to take. Only something empty, and changed no
 * earlier than the operation recorded its intent, is taken for it: a file or
 * folder with anything in it is never touched, and an empty one someone made
 * in that same instant holds nothing to lose.
 */
const removePlaceholderLeftByCrash = async (target, sinceIso) => {
  if (!target) return false;
  const since = Date.parse(sinceIso);
  const stats = await lstatOrNull(target);
  if (!stats || !Number.isFinite(since) || stats.ctimeMs < since - PLACEHOLDER_CLOCK_MARGIN_MS) {
    return false;
  }
  try {
    if (stats.isDirectory()) {
      // rmdir refuses a folder that is not empty.
      await fsp.rmdir(target);
      return true;
    }
    if (stats.isFile() && stats.size === 0) {
      await fsp.unlink(target);
      return true;
    }
  } catch {
    /* no longer empty, or already gone */
  }
  return false;
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

/**
 * A folder someone chose to restore into, rather than the one an item came
 * from. It must exist already — nothing is created for a destination someone
 * picked — and must not lead into a trash zone, however it resolves.
 *
 * @returns {Promise<{directory: string} | {status: 'blocked', reason: string}>}
 */
const checkChosenDestination = async (directory) => {
  const invalid = { status: 'blocked', reason: 'invalid-destination' };
  let resolved;
  try {
    resolved = await fsp.realpath(directory);
    if (!(await fsp.stat(resolved)).isDirectory()) return invalid;
  } catch {
    return invalid;
  }
  const insideZone = (candidate) => candidate.split(path.sep).includes(ZONE_DIRECTORY_NAME);
  if (insideZone(path.resolve(directory)) || insideZone(resolved)) return invalid;
  // The path as it was given: the resolved one only served to check it. A
  // device compared through a link can be wrong, which the rename then says
  // with EXDEV, and the restore copies instead.
  return { directory: path.resolve(directory) };
};

/** The hidden name a copy is written under, beside where it is going, until it is whole. */
const STAGING_PREFIX = '.nextexplorer-restoring-';
const stagingPathFor = (restorePath, itemId) =>
  path.join(path.dirname(restorePath), `${STAGING_PREFIX}${itemId}`);

/**
 * Bytes copied, as deltas, whichever copy is running. The stream copy reports
 * each chunk as a number; rsync reports a running total for its whole run, as
 * `{ copiedBytes, percent }`, which is what the container uses.
 */
const bytesReporter = (onBytes) => {
  if (typeof onBytes !== 'function') return undefined;
  let reported = 0;
  return (progress) => {
    if (typeof progress === 'number') {
      onBytes(progress);
      return;
    }
    const total = Number(progress?.copiedBytes);
    if (!Number.isFinite(total) || total <= reported) return;
    onBytes(total - reported);
    reported = total;
  };
};

/** Required when used: the transfer service itself requires the trash. */
const copyTree = (source, destination, isDirectory, onBytes, signal) =>
  require('../fileTransferService').copyEntryWithProgress(
    source,
    destination,
    isDirectory,
    bytesReporter(onBytes),
    signal
  );

/** Far past any real race for one name; a bound so a filesystem answering EEXIST to everything ends in an error. */
const MAX_NAMING_ATTEMPTS = 100;

/**
 * Move a whole copy from its hidden name to where it goes, never replacing
 * what holds that name: one taken since the copy started, or at the last
 * moment, gets the next free one. Each name is recorded before the copy is
 * moved under it, so a crash leaves the recovery looking at the right one.
 *
 * Answers the path the copy took.
 */
const nameCopy = async ({ db, item, staging, entryPath, restorePath, stoppedSince = null }) => {
  const directory = path.dirname(restorePath);
  const desired = path.basename(restorePath);
  let target = restorePath;
  for (let attempt = 1; attempt <= MAX_NAMING_ATTEMPTS; attempt += 1) {
    // A crash between the link and the removal of the hidden name left the
    // copy under both: it is already named.
    const alreadyNamed =
      (await linkedUnderBoth(staging, target)) ||
      (stoppedSince !== null && (await sameLinkUnderBoth(staging, target, stoppedSince)));
    if (!alreadyNamed) {
      try {
        await moveNoReplace(staging, target);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        target = path.join(directory, await findAvailableName(directory, desired));
        store.setItemState(db, item.id, 'copied', { restorePath: target, restoreEntry: entryPath });
        continue;
      }
    }
    await dropOldName(staging, target);
    return target;
  }
  throw Object.assign(new Error(`No free name for a restored copy in ${directory}`), {
    code: 'EEXIST',
  });
};

/**
 * The end of a restore across disks, once its copy is whole: named where it
 * goes, the trash's copy removed, the record finished. Called by the restore
 * itself and by the recovery after a crash, so it can only move forward.
 *
 * A name taken since the copy started gets the next free one; nothing is ever
 * replaced. And when neither the copy nor anything at its destination is there
 * any more, the trash's copy is kept.
 */
const finishCopy = async ({
  db,
  item,
  payload,
  sidecar,
  entryPath,
  restorePath,
  stoppedSince = null,
}) => {
  const staging = stagingPathFor(restorePath, item.id);
  let finalPath = restorePath;

  if (await exists(staging)) {
    // Resumed after a crash: the name may still be held by the empty entry the
    // interrupted move took it with.
    if (stoppedSince) await removePlaceholderLeftByCrash(restorePath, stoppedSince);
    finalPath = await nameCopy({ db, item, staging, entryPath, restorePath, stoppedSince });
  } else if (!(await exists(finalPath))) {
    store.setItemState(db, item.id, 'trashed');
    return { status: 'lost-copy' };
  }
  await failpoints.hit('copy:after-rename', { id: item.id });

  if (entryPath) {
    const found = await walkInside(payload, entrySegments(entryPath) || []);
    if (found) await fsp.rm(found.absolutePath, { recursive: true, force: true });
  } else {
    await fsp.rm(payload, { recursive: true, force: true });
  }
  await failpoints.hit('copy:after-remove', { id: item.id });

  const versionTarget = await versionLifecycle.targetForRestore(db, {
    itemId: item.id,
    entryPath: entryPath || null,
    zone: store.getZone(db, item.zoneId),
    restorePath: finalPath,
  });
  const relink = () =>
    versionLifecycle.relinkRestored(db, {
      itemId: item.id,
      entryPath: entryPath || null,
      target: versionTarget,
      restorePath: finalPath,
    });
  if (entryPath) {
    const stillThere = await exists(payload);
    const remaining = stillThere ? (await measure(payload)).bytes : 0;
    db.transaction(() => {
      relink();
      store.setItemSize(db, item.id, remaining);
      store.setItemState(db, item.id, 'trashed');
    })();
  } else {
    db.transaction(() => {
      relink();
      store.deleteItem(db, item.id);
    })();
    await fsp.rm(sidecar, { force: true });
  }
  return { status: 'restored', restorePath: finalPath };
};

/**
 * Restore across disks. A rename cannot cross them, so the content is copied
 * under a hidden name beside where it is going, and only once that copy is
 * whole does the restore commit to it:
 *
 *   copying  the intent, then the copy written beside the destination
 *   copied   the copy is whole: from here the restore only moves forward
 *
 * A crash while `copying` throws the partial copy away and leaves the item in
 * the trash; a crash once `copied` finishes the restore. The content is never
 * left in neither place.
 */
const copyOut = async ({
  db,
  item,
  payload,
  sidecar,
  source,
  isDirectory,
  entryPath,
  restorePath,
  onBytes,
  signal,
}) => {
  const intent = { restorePath, restoreEntry: entryPath };
  const staging = stagingPathFor(restorePath, item.id);
  store.setItemState(db, item.id, 'copying', intent);
  await failpoints.hit('copy:after-intent', { id: item.id });

  try {
    await fsp.rm(staging, { recursive: true, force: true });
    await copyTree(source, staging, isDirectory, onBytes, signal);
    await failpoints.hit('copy:after-copy', { id: item.id });
  } catch (error) {
    if (error?.simulatedCrash) throw error;
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    store.setItemState(db, item.id, 'trashed');
    if (error?.code === 'OPERATION_CANCELLED') return { status: 'cancelled' };
    throw error;
  }

  store.setItemState(db, item.id, 'copied', intent);
  await failpoints.hit('copy:after-mark', { id: item.id });
  return finishCopy({ db, item, payload, sidecar, entryPath, restorePath });
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

    // The item and the histories of what it holds reach the trash together.
    db.transaction(() => {
      store.setItemState(db, id, 'trashed');
      versionLifecycle.relinkTrashed(db, record);
    })();
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
const restoreItem = async (itemId, { destinationDirectory = null, onBytes, signal } = {}) => {
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

    let parent = path.dirname(item.originalPath);
    if (destinationDirectory) {
      const chosen = await checkChosenDestination(destinationDirectory);
      if (chosen.status) return chosen;
      parent = chosen.directory;
    } else {
      const refused = await prepareDestination(zone, parent);
      if (refused) return refused;
    }

    const name = await findAvailableName(parent, item.name);
    const restorePath = path.join(parent, name);
    const copyAcross = async () => {
      const outcome = await copyOut({
        db,
        item,
        payload,
        sidecar,
        source: payload,
        isDirectory: item.kind === 'directory',
        entryPath: null,
        restorePath,
        onBytes,
        signal,
      });
      if (outcome.status !== 'restored') return outcome;
      return { ...outcome, item, renamed: path.basename(outcome.restorePath) !== item.name };
    };
    if (destinationDirectory && !(await zones.sameDevice(payload, parent))) return copyAcross();

    const versionTarget = await versionLifecycle.targetForRestore(db, {
      itemId: item.id,
      zone,
      restorePath,
    });
    store.setItemState(db, item.id, 'restoring', { restorePath });
    await failpoints.hit('restore:after-intent', { id: item.id });

    try {
      // Not rename(2), which replaces a file, or an empty folder, that took the
      // name since it was chosen: the name is taken by an operation that fails
      // when it is held.
      await moveNoReplace(payload, restorePath);
    } catch (error) {
      // A crash stops here as a process that died would: nothing undone.
      if (error?.simulatedCrash) throw error;
      store.setItemState(db, item.id, 'trashed');
      if (error?.code === 'EEXIST') return { status: 'busy' };
      // Two mount points of one filesystem share a device and refuse a rename
      // all the same: a destination someone chose is still reached, by copy.
      if (error?.code === 'EXDEV' && destinationDirectory) return copyAcross();
      throw error;
    }
    // Outside the undo above: the content is at its destination already.
    await dropOldName(payload, restorePath);
    await failpoints.hit('restore:after-rename', { id: item.id });

    // Back to life first: the item's row takes whatever histories are still
    // linked to it when it goes.
    db.transaction(() => {
      versionLifecycle.relinkRestored(db, {
        itemId: item.id,
        target: versionTarget,
        restorePath,
      });
      store.deleteItem(db, item.id);
    })();
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
const restoreEntry = async (
  itemId,
  entryPath,
  { destinationDirectory = null, onBytes, signal } = {}
) => {
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

    const wanted = segments.at(-1);
    let parent = path.dirname(path.join(item.originalPath, ...segments));
    if (destinationDirectory) {
      const chosen = await checkChosenDestination(destinationDirectory);
      if (chosen.status) return chosen;
      parent = chosen.directory;
    } else {
      const refused = await prepareDestination(zone, parent);
      if (refused) return refused;
    }

    const kind = found.stats.isDirectory() ? 'directory' : 'file';
    const { bytes: size } = await measure(found.absolutePath);
    const name = await findAvailableName(parent, wanted);
    const restorePath = path.join(parent, name);
    const copyAcross = async () => {
      const outcome = await copyOut({
        db,
        item,
        payload,
        sidecar,
        source: found.absolutePath,
        isDirectory: kind === 'directory',
        entryPath: segments.join('/'),
        restorePath,
        onBytes,
        signal,
      });
      if (outcome.status !== 'restored') return outcome;
      return {
        ...outcome,
        item: store.getItem(db, item.id),
        kind,
        size,
        renamed: path.basename(outcome.restorePath) !== wanted,
      };
    };
    if (destinationDirectory && !(await zones.sameDevice(found.absolutePath, parent))) {
      return copyAcross();
    }

    const entry = segments.join('/');
    const versionTarget = await versionLifecycle.targetForRestore(db, {
      itemId: item.id,
      entryPath: entry,
      zone,
      restorePath,
    });
    // Which entry, too: the recovery needs it to bring that entry's histories back.
    store.setItemState(db, item.id, 'extracting', { restorePath, restoreEntry: entry });
    await failpoints.hit('extract:after-intent', { id: item.id });

    try {
      // Never replacing what took the name since it was chosen, as for a whole item.
      await moveNoReplace(found.absolutePath, restorePath);
    } catch (error) {
      if (error?.simulatedCrash) throw error;
      store.setItemState(db, item.id, 'trashed');
      if (error?.code === 'EEXIST') return { status: 'busy' };
      if (error?.code === 'EXDEV' && destinationDirectory) return copyAcross();
      throw error;
    }
    await dropOldName(found.absolutePath, restorePath);
    await failpoints.hit('extract:after-rename', { id: item.id });

    const remaining = (await measure(payload)).bytes;
    db.transaction(() => {
      versionLifecycle.relinkRestored(db, {
        itemId: item.id,
        entryPath: entry,
        target: versionTarget,
        restorePath,
      });
      store.setItemSize(db, item.id, remaining);
      store.setItemState(db, item.id, 'trashed');
    })();
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
 * A file in the trash to read, for a preview: the item itself when it is a
 * file, or a file inside a deleted folder. Only a regular file, reached
 * through real directories; a symbolic link is never opened.
 *
 * @returns {Promise<{status: 'found', item: object, absolutePath: string, size: number,
 *   modifiedAt: string} | {status: 'missing'|'invalid-path'|'not-file'} |
 *   {status: 'unavailable', reason: string}>}
 */
const locateFile = async (itemId, entryPath = '') => {
  const segments = entrySegments(entryPath);
  if (!segments) return { status: 'invalid-path' };
  const db = await getDb();
  const item = store.getItem(db, itemId);
  if (!item || !['trashed', 'extracting'].includes(item.state)) return { status: 'missing' };

  const zone = store.getZone(db, item.zoneId);
  const inspection = zone ? await zones.inspectZone(zone) : { reason: 'missing' };
  if (!inspection.available) return { status: 'unavailable', reason: inspection.reason };

  const found = await walkInside(confinedPaths(zone, item.id).payload, segments);
  if (!found) return { status: 'missing' };
  if (!found.stats.isFile()) return { status: 'not-file' };
  return {
    status: 'found',
    item,
    absolutePath: found.absolutePath,
    size: found.stats.size,
    modifiedAt: found.stats.mtime.toISOString(),
  };
};

/** What an entry inside a deleted folder is — its kind and size — or null when it is not there. */
const describeEntry = async (itemId, entryPath) => {
  const segments = entrySegments(entryPath);
  if (!segments?.length) return null;
  const db = await getDb();
  const item = store.getItem(db, itemId);
  const zone = item ? store.getZone(db, item.zoneId) : null;
  if (!zone || !(await zones.inspectZone(zone)).available) return null;
  const found = await walkInside(confinedPaths(zone, item.id).payload, segments);
  if (!found) return null;
  return {
    kind: found.stats.isDirectory() ? 'directory' : 'file',
    size: (await measure(found.absolutePath)).bytes,
  };
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

    // The row takes the histories with it; their versions go now, so the space
    // comes back with the item's.
    const released = versionLifecycle.filesInTrashItem(db, item.id);
    store.deleteItem(db, item.id);
    await fsp.rm(sidecar, { force: true });
    await versionLifecycle.purgeFiles(released);
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
        db.transaction(() => {
          store.setItemState(db, row.id, 'trashed');
          versionLifecycle.relinkTrashed(db, row);
        })();
        report.finished += 1;
      } else if (await exists(row.originalPath)) {
        await drop(row, paths.sidecar);
        report.undone += 1;
      } else {
        await drop(row, paths.sidecar, 'lost');
        report.lost += 1;
      }
    } else if (row.state === 'restoring') {
      // A file linked under its destination's name and not yet removed from
      // the zone had reached its place: the restore finishes. Anything else at
      // the destination while the content is still here is not the restore:
      // the empty file or folder the move held the name with goes, and what
      // someone else put there stays.
      const linked =
        hasPayload &&
        row.restorePath &&
        ((await linkedUnderBoth(paths.payload, row.restorePath)) ||
          (await sameLinkUnderBoth(paths.payload, row.restorePath, row.updatedAt)));
      if (linked) await fsp.unlink(paths.payload);
      if (hasPayload && !linked) {
        await removePlaceholderLeftByCrash(row.restorePath, row.updatedAt);
        store.setItemState(db, row.id, 'trashed');
        report.undone += 1;
      } else if (row.restorePath && (await exists(row.restorePath))) {
        const versionTarget = await versionLifecycle.targetForRestore(db, {
          itemId: row.id,
          zone,
          restorePath: row.restorePath,
        });
        versionLifecycle.relinkRestored(db, {
          itemId: row.id,
          target: versionTarget,
          restorePath: row.restorePath,
        });
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
        // The entry left if it is at its destination and no longer in the folder:
        // its histories follow it out.
        const entrySegmentsLeft = row.restoreEntry ? entrySegments(row.restoreEntry) : null;
        // Linked under its destination's name and still in the folder: it had
        // reached its place, and only its name in the folder goes.
        if (entrySegmentsLeft?.length && row.restorePath) {
          const inside = await walkInside(paths.payload, entrySegmentsLeft);
          if (
            inside &&
            ((await linkedUnderBoth(inside.absolutePath, row.restorePath)) ||
              (await sameLinkUnderBoth(inside.absolutePath, row.restorePath, row.updatedAt)))
          ) {
            await fsp.unlink(inside.absolutePath);
          } else if (inside) {
            // Still in the folder: its destination holds at most the empty
            // entry the move took the name with.
            await removePlaceholderLeftByCrash(row.restorePath, row.updatedAt);
          }
        }
        if (
          entrySegmentsLeft?.length &&
          row.restorePath &&
          (await exists(row.restorePath)) &&
          !(await walkInside(paths.payload, entrySegmentsLeft))
        ) {
          const versionTarget = await versionLifecycle.targetForRestore(db, {
            itemId: row.id,
            entryPath: row.restoreEntry,
            zone,
            restorePath: row.restorePath,
          });
          versionLifecycle.relinkRestored(db, {
            itemId: row.id,
            entryPath: row.restoreEntry,
            target: versionTarget,
            restorePath: row.restorePath,
          });
        }
        store.setItemSize(db, row.id, (await measure(paths.payload)).bytes);
        store.setItemState(db, row.id, 'trashed');
        report.finished += 1;
      } else {
        await drop(row, paths.sidecar, 'lost');
        report.lost += 1;
      }
    } else if (row.state === 'copying') {
      // The copy never became whole: it goes, and the item stays in the trash.
      if (row.restorePath) {
        await fsp.rm(stagingPathFor(row.restorePath, row.id), { recursive: true, force: true });
      }
      if (hasPayload) {
        store.setItemState(db, row.id, 'trashed');
        report.undone += 1;
      } else {
        await drop(row, paths.sidecar, 'lost');
        report.lost += 1;
      }
    } else if (row.state === 'copied') {
      // The copy was whole: the restore goes on to its end.
      const outcome = row.restorePath
        ? await finishCopy({
            db,
            item: row,
            payload: paths.payload,
            sidecar: paths.sidecar,
            entryPath: row.restoreEntry,
            restorePath: row.restorePath,
            stoppedSince: row.updatedAt,
          })
        : null;
      if (outcome?.status === 'restored') {
        report.finished += 1;
      } else {
        if (!outcome) store.setItemState(db, row.id, 'trashed');
        report.undone += 1;
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
      await drop(row, zones.itemPaths(zone.root, row.id).sidecar, 'lost');
      report.lost += 1;
    }
  }

  for (const name of names) {
    if (name.endsWith('.json')) {
      const id = name.slice(0, -'.json'.length);
      if (!knownIds.has(id) && !onDisk.has(id) && ITEM_ID_PATTERN.test(id)) {
        await fsp.rm(path.join(trashDirectory, name), { force: true });
        report.removedSidecars += 1;
      }
      continue;
    }
    if (knownIds.has(name) || !ITEM_ID_PATTERN.test(name)) continue;

    const { payload, sidecar } = zones.itemPaths(zone.root, name);
    const described = onDisk.has(`${name}.json`) ? await readSidecar(sidecar) : null;
    const stats = await fsp.lstat(payload).catch(() => null);
    if (!stats) continue;
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
  STAGING_PREFIX,
  moveToTrash,
  restoreItem,
  listEntries,
  locateFile,
  describeEntry,
  restoreEntry,
  purgeItem,
  forgetItem,
  recoverZone,
};
