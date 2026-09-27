/**
 * A file's history follows the file.
 *
 * Files are known by their path, so every way the application moves one moves
 * its history too: a rename or a move, into the trash and back out of it, into
 * a folder someone chose. Whatever ends a file ends its history — deleted for
 * good straight away, purged from the trash, expired, evicted — and a file that
 * disappears outside the application leaves its history orphaned, its versions
 * the only copy left, until the retention runs out or the file comes back.
 *
 * Nothing is copied for any of it. A version's content stays in the zone it was
 * captured in, wherever its file goes afterwards; only the records move.
 *
 * The functions called from inside the trash's own operations are synchronous
 * database writes, so the trash can make them part of the same transaction as
 * its own record: an item never reaches the trash, or leaves it, without its
 * histories.
 */
const fsp = require('fs/promises');
const path = require('path');

const logger = require('../../utils/logger');
const { getDb } = require('../db');
const clock = require('../trash/clock');
const { DAY_MS } = require('../trash/policy');
const trashStore = require('../trash/store');
const zones = require('../trash/zones');
const operations = require('./operations');
const { thinVersions } = require('./policy');
const store = require('./store');

/**
 * `column` is `prefix`, or something inside it: every path that begins with
 * `prefix/` sorts at or after it and before `prefix0`, `0` being the character
 * right after `/`.
 *
 * It was `LIKE 'prefix/%'`, which ignores case for ASCII as SQLite's LIKE
 * always does. Moving `Docs` reassigned the histories of `docs/…` to files
 * under the new name, and deleting it for good purged them — another folder,
 * on a Linux volume, and its versions gone with the wrong one.
 */
const under = (column) => `(${column} = ? OR (${column} >= ? AND ${column} < ?))`;
const underValues = (prefix) => [prefix, `${prefix}/`, `${prefix}0`];

/** What is left of `full` inside `prefix`: '' for the prefix itself. */
const inside = (full, prefix) => (full === prefix ? '' : full.slice(prefix.length + 1));

const joinPath = (...parts) => parts.filter(Boolean).join('/');

const toRelative = (root, absolutePath) =>
  path.relative(root, absolutePath).split(path.sep).join('/');

const lstatOrNull = async (absolutePath) => {
  try {
    return await fsp.lstat(absolutePath);
  } catch {
    return null;
  }
};

/** A live history about to take a path: whatever other live history claimed it had lost its file. */
const vacate = (db, zoneId, relativePath, exceptId) =>
  db
    .prepare(
      `UPDATE version_files SET state = 'orphaned', orphaned_at = ?, updated_at = ?
        WHERE zone_id = ? AND relative_path = ? AND state = 'live' AND id != ?`
    )
    .run(clock.nowIso(), clock.nowIso(), zoneId, relativePath, exceptId);

/**
 * The histories of what a trash item holds go into the trash with it: the item
 * itself, and for a folder everything inside it, each remembering where inside.
 */
const relinkTrashed = (db, item) => {
  const rows = db
    .prepare(
      `SELECT id, relative_path FROM version_files
        WHERE zone_id = ? AND state IN ('live', 'orphaned') AND ${under('relative_path')}`
    )
    .all(item.zoneId, ...underValues(item.relativePath));
  const update = db.prepare(
    `UPDATE version_files SET state = 'trashed', trash_item_id = ?, trash_entry = ?,
       orphaned_at = NULL, updated_at = ? WHERE id = ?`
  );
  const now = clock.nowIso();
  for (const row of rows) {
    update.run(item.id, inside(row.relative_path, item.relativePath), now, row.id);
  }
  return rows.length;
};

/** The histories an item in the trash holds, or those under one entry of it. */
const trashedHistories = (db, itemId, entryPath = null) => {
  const rows = db
    .prepare(
      "SELECT id, trash_entry FROM version_files WHERE trash_item_id = ? AND state = 'trashed'"
    )
    .all(itemId);
  if (!entryPath) return rows;
  return rows.filter(
    (row) => row.trash_entry === entryPath || String(row.trash_entry).startsWith(`${entryPath}/`)
  );
};

/** The histories that go when a trash item goes, to purge once its row is removed. */
const filesInTrashItem = (db, itemId) => trashedHistories(db, itemId).map((row) => row.id);

/**
 * The zone a restored path belongs to, looked up before the restore commits so
 * the commit itself stays a synchronous write. Undefined when nothing restored
 * there has a history, so no zone is ever created for nothing; null when the
 * place has no zone.
 */
const targetForRestore = async (db, { itemId, entryPath = null, zone = null, restorePath }) => {
  if (trashedHistories(db, itemId, entryPath).length === 0) return undefined;
  const absolute = path.resolve(restorePath);
  if (
    zone &&
    zones.isWithin(zone.root, absolute) &&
    absolute !== zone.root &&
    !zones.isWithin(zones.zoneDirectory(zone.root), absolute)
  ) {
    return { zoneId: zone.id, root: zone.root };
  }
  const located = await zones.locateZoneRoot(absolute);
  if (!located.root) return null;
  try {
    const target = await zones.ensureZone(located.root);
    return { zoneId: target.id, root: target.root };
  } catch (error) {
    logger.warn({ err: error, restorePath }, 'Restored histories found no zone to follow into');
    return null;
  }
};

/**
 * The histories of what a restore brought back come back to life, at the path
 * the content now has: the item, or one entry of it and what that entry holds.
 * A place with no zone cannot keep a history, and they go.
 */
const relinkRestored = (db, { itemId, entryPath = null, target, restorePath }) => {
  if (target === undefined) return 0;
  const rows = trashedHistories(db, itemId, entryPath);
  if (rows.length === 0) return 0;
  const now = clock.nowIso();
  if (!target) {
    for (const row of rows) store.setFileState(db, row.id, 'purging');
    return rows.length;
  }
  const base = toRelative(target.root, path.resolve(restorePath));
  const update = db.prepare(
    `UPDATE version_files SET state = 'live', zone_id = ?, relative_path = ?,
       trash_item_id = NULL, trash_entry = NULL, orphaned_at = NULL, updated_at = ? WHERE id = ?`
  );
  for (const row of rows) {
    const innerPath = entryPath ? inside(row.trash_entry, entryPath) : row.trash_entry;
    const relativePath = joinPath(base, innerPath);
    vacate(db, target.zoneId, relativePath, row.id);
    update.run(target.zoneId, relativePath, now, row.id);
  }
  return rows.length;
};

/** Let histories go, contents first, each failure logged and left to the maintenance. */
const purgeFiles = async (fileIds) => {
  for (const fileId of fileIds) {
    try {
      await operations.purgeFile(fileId);
    } catch (error) {
      logger.warn({ err: error, fileId }, 'A file history could not be purged');
    }
  }
};

/** The live or orphaned histories at a path or under it, with the zone root they were found in. */
const historiesUnder = async (db, absolutePath) => {
  const located = await zones.locateZoneRoot(path.resolve(absolutePath));
  if (!located.root) return { root: null, prefix: null, rows: [] };
  const zoneIds = trashStore
    .listZones(db)
    .filter((zone) => zone.root === located.root)
    .map((zone) => zone.id);
  if (zoneIds.length === 0) return { root: located.root, prefix: null, rows: [] };
  const prefix = toRelative(located.root, path.resolve(absolutePath));
  const rows = db
    .prepare(
      `SELECT id, zone_id, relative_path FROM version_files
        WHERE zone_id IN (${zoneIds.map(() => '?').join(', ')})
          AND state IN ('live', 'orphaned') AND ${under('relative_path')}`
    )
    .all(...zoneIds, ...underValues(prefix));
  return { root: located.root, prefix, rows };
};

/**
 * What deleting here for good would destroy, before anyone has agreed to it.
 *
 * Versions are the one thing a deletion takes that cannot be seen from the
 * folder: the file is on screen and its history is not, so "delete" reads as
 * one file going and takes ten earlier copies of it with it. Asked for a path
 * or a whole tree, because a folder is deleted the same way and every file
 * under it brings its own.
 *
 * Counted in one query rather than over the rows, so a folder with a thousand
 * versioned files under it is one question to the database and not a thousand
 * — and no list of ids long enough to run into the limit on how many a
 * statement may carry.
 */
const countUnder = async (absolutePath) => {
  const none = { files: 0, versions: 0, bytes: 0 };
  try {
    const db = await getDb();
    const located = await zones.locateZoneRoot(path.resolve(absolutePath));
    if (!located.root) return none;
    const zoneIds = trashStore
      .listZones(db)
      .filter((zone) => zone.root === located.root)
      .map((zone) => zone.id);
    if (zoneIds.length === 0) return none;

    const prefix = toRelative(located.root, path.resolve(absolutePath));
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT vf.id) AS files,
                COUNT(v.id) AS versions,
                COALESCE(SUM(v.size_bytes), 0) AS bytes
           FROM version_files vf
           JOIN file_versions v ON v.file_id = vf.id AND v.state = 'kept'
          WHERE vf.zone_id IN (${zoneIds.map(() => '?').join(', ')})
            AND vf.state IN ('live', 'orphaned') AND ${under('vf.relative_path')}`
      )
      .get(...zoneIds, ...underValues(prefix));

    return {
      files: Number(row?.files) || 0,
      versions: Number(row?.versions) || 0,
      bytes: Number(row?.bytes) || 0,
    };
  } catch (error) {
    // A count is not worth failing a confirmation over: the dialog says what
    // it knows, and the deletion itself is unchanged.
    logger.debug({ err: error, absolutePath }, 'File versions were not counted for a deletion');
    return none;
  }
};

/**
 * A file or folder the application renamed or moved: the histories at the old
 * path, or under it, now name the new one — in another zone when it went to
 * another volume, where their versions stay put and keep being theirs.
 */
const onMoved = async (fromAbsolute, toAbsolute) => {
  try {
    const db = await getDb();
    const { rows, prefix } = await historiesUnder(db, fromAbsolute);
    if (rows.length === 0) return 0;
    const to = path.resolve(toAbsolute);
    const located = await zones.locateZoneRoot(to);
    let target = null;
    if (located.root) {
      try {
        const zone = await zones.ensureZone(located.root);
        target = { zoneId: zone.id, root: zone.root };
      } catch (error) {
        logger.warn({ err: error, to }, 'Moved histories found no zone to follow into');
      }
    }

    const base = target ? toRelative(target.root, to) : null;
    db.transaction(() => {
      const now = clock.nowIso();
      for (const row of rows) {
        if (!target) {
          store.setFileState(db, row.id, 'purging');
          continue;
        }
        const relativePath = joinPath(base, inside(row.relative_path, prefix));
        vacate(db, target.zoneId, relativePath, row.id);
        db.prepare(
          'UPDATE version_files SET zone_id = ?, relative_path = ?, updated_at = ? WHERE id = ?'
        ).run(target.zoneId, relativePath, now, row.id);
      }
    })();
    if (!target) await purgeFiles(rows.map((row) => row.id));
    return rows.length;
  } catch (error) {
    logger.warn({ err: error, fromAbsolute, toAbsolute }, 'File histories did not follow a move');
    return 0;
  }
};

/**
 * A file or folder deleted for good by the application: its histories go with
 * it, now — the space comes back at once rather than at the next pass.
 */
const onDeleted = async (absolutePath) => {
  const none = { files: 0, versions: 0, bytes: 0 };
  try {
    const db = await getDb();
    const { rows } = await historiesUnder(db, absolutePath);
    if (rows.length === 0) return none;
    // Counted before they go, so a deletion can say what it took. Afterwards
    // there is nothing left to count.
    const taken = await countUnder(absolutePath);
    db.transaction(() => {
      for (const row of rows) store.setFileState(db, row.id, 'purging');
    })();
    await purgeFiles(rows.map((row) => row.id));
    return taken;
  } catch (error) {
    logger.warn({ err: error, absolutePath }, 'File histories did not go with a deletion');
    return none;
  }
};

const REVIEW_BATCH = 64;

/**
 * What the maintenance learns about a zone's histories from the disk.
 *
 * - A file gone from its path, outside the application, leaves its history
 *   orphaned — unless so many have gone at once that the volume itself looks
 *   wrong, in which case nothing is marked and the pass says so.
 * - An orphaned history whose file is back at its path is the file's again.
 * - An orphaned history past the retention goes, versions and all.
 */
const reviewZone = async (
  zone,
  { retentionDays = 30, breakerRatio = 0.2, breakerMinimum = 5 } = {}
) => {
  const report = { orphaned: 0, reattached: 0, expired: 0, breaker: false };
  const inspection = await zones.inspectZone(zone);
  if (!inspection.available) return { ...report, skipped: true, reason: inspection.reason };

  const db = await getDb();
  const files = store
    .listFiles(db, { zoneId: zone.id })
    .filter((file) => file.state === 'live' || file.state === 'orphaned');
  const checked = [];
  for (let index = 0; index < files.length; index += REVIEW_BATCH) {
    const batch = await Promise.all(
      files.slice(index, index + REVIEW_BATCH).map(async (file) => {
        const stats = await lstatOrNull(path.join(zone.root, ...file.relativePath.split('/')));
        return { file, present: Boolean(stats?.isFile()) };
      })
    );
    checked.push(...batch);
  }

  const live = checked.filter((entry) => entry.file.state === 'live');
  const vanished = live.filter((entry) => !entry.present);
  if (vanished.length >= breakerMinimum && vanished.length / live.length > breakerRatio) {
    report.breaker = true;
    trashStore.insertEvent(db, {
      zoneId: zone.id,
      kind: 'versions-breaker',
      detail: JSON.stringify({ vanished: vanished.length, live: live.length }),
    });
  } else {
    for (const { file } of vanished) {
      // Looked at again from the records: a move may have taken it meanwhile.
      const current = store.getFile(db, file.id);
      if (current?.state !== 'live' || current.relativePath !== file.relativePath) continue;
      store.setFileState(db, file.id, 'orphaned', { orphanedAt: clock.nowIso() });
      report.orphaned += 1;
    }
  }
  for (const { file, present } of checked) {
    if (file.state === 'orphaned' && present) {
      store.setFileState(db, file.id, 'live');
      report.reattached += 1;
    }
  }

  const expiry = clock.now() - retentionDays * DAY_MS;
  for (const file of store.listFiles(db, { zoneId: zone.id, state: 'orphaned' })) {
    const orphanedAt = Date.parse(file.orphanedAt || '');
    if (Number.isFinite(orphanedAt) && orphanedAt > expiry) continue;
    await purgeFiles([file.id]);
    report.expired += 1;
  }
  return report;
};

/**
 * The versions whose content this zone holds, as the zone's plan needs them:
 * each marked expired when the thinning of its file lets it go. The thinning
 * looks at the whole history, wherever its other versions are kept.
 */
const zoneVersions = (db, zone, { now, settings }) => {
  const stored = store
    .listVersionsInZone(db, zone.id)
    .filter((version) => version.state === 'kept' && !operations.inflight.has(version.id));
  const expired = new Map();
  const files = new Map();
  for (const fileId of new Set(stored.map((version) => version.fileId))) {
    const file = store.getFile(db, fileId);
    files.set(fileId, file);
    if (!file || file.state === 'purging') continue;
    const history = store
      .listVersionsOfFile(db, fileId)
      .filter((version) => !operations.inflight.has(version.id))
      .map((version) => ({
        id: version.id,
        modifiedAt: Date.parse(version.modifiedAt),
        pinned: version.pinned,
      }));
    for (const entry of thinVersions({ versions: history, now, settings })) {
      expired.set(entry.id, entry.reason);
    }
  }
  return stored
    .filter((version) => files.get(version.fileId) && files.get(version.fileId).state !== 'purging')
    .map((version) => ({
      id: version.id,
      size: version.size,
      modifiedAt: Date.parse(version.modifiedAt),
      fileId: version.fileId,
      pinned: version.pinned,
      expired: expired.get(version.id) || false,
    }));
};

module.exports = {
  relinkTrashed,
  filesInTrashItem,
  targetForRestore,
  relinkRestored,
  purgeFiles,
  onMoved,
  onDeleted,
  countUnder,
  reviewZone,
  zoneVersions,
};
