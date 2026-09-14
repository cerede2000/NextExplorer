/**
 * The share links of what is in the trash.
 *
 * A share must not go on publishing something that was deleted, so its row
 * leaves the shares table the moment the content goes to the trash: the link
 * stops working at once. What the share was is kept here, against the trash
 * item, so that a restore can bring it back as it was — the same link,
 * password, expiry, permissions and label — pointed at wherever the content
 * now is, or let it go.
 *
 * Kept rows belong to their item and go with it: purged, emptied, expired,
 * evicted, forgotten or lost, the item takes its shares with it for good
 * (`ON DELETE CASCADE`). A restore reads them before the item is gone, and
 * then brings them back or lets them go, as the person restoring chose.
 *
 * Guest sessions are not kept: bringing one back would re-open an access
 * nobody asked for again.
 */
const { generateId } = require('../../utils/ids');
const { getDb } = require('../db');
const clock = require('./clock');

const CHOICES = Object.freeze({ restore: 'restore', drop: 'drop' });

const normalize = (value = '') =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

/** Where `candidate` sits inside `root`: '' for the root itself, null when outside. */
const relativeInside = (root, candidate) => {
  if (candidate === root) return '';
  return candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : null;
};

const parse = (row) => ({
  shareId: row.share_id,
  itemId: row.item_id,
  relative: row.relative_path,
  share: JSON.parse(row.share_row),
  permittedUserIds: JSON.parse(row.permitted_user_ids || '[]'),
});

/**
 * Keep what these shares were, against the trash item their content went into.
 * `source` is where that content was, as shares name it: its space and path.
 * Called just before the shares themselves are deleted.
 */
const suspend = async (itemId, source, shareIds) => {
  const ids = [...new Set((Array.isArray(shareIds) ? shareIds : []).filter(Boolean))];
  if (!itemId || ids.length === 0 || !source?.sourceSpace) return 0;
  const db = await getDb();
  const root = normalize(source.sourcePath);
  const readShare = db.prepare('SELECT * FROM shares WHERE id = ?');
  const readPermissions = db.prepare('SELECT user_id FROM share_permissions WHERE share_id = ?');
  // One share can be under two things deleted together: the first keeps it.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trash_shares
       (share_id, item_id, relative_path, share_row, permitted_user_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let kept = 0;
  db.transaction(() => {
    for (const id of ids) {
      const row = readShare.get(id);
      if (!row || row.source_space !== source.sourceSpace) continue;
      const relative = relativeInside(root, normalize(row.source_path));
      if (relative === null) continue;
      const permitted = readPermissions.all(id).map((permission) => permission.user_id);
      kept += insert.run(
        id,
        itemId,
        relative,
        JSON.stringify(row),
        JSON.stringify(permitted),
        clock.nowIso()
      ).changes;
    }
  })();
  return kept;
};

/** The shares kept for one item. */
const listForItem = async (itemId) => {
  const db = await getDb();
  return db
    .prepare('SELECT * FROM trash_shares WHERE item_id = ? ORDER BY relative_path, share_id')
    .all(itemId)
    .map(parse);
};

/** How many shares each item keeps, as a map from item id. */
const countByItem = async () => {
  const db = await getDb();
  return new Map(
    db
      .prepare('SELECT item_id, COUNT(*) AS count FROM trash_shares GROUP BY item_id')
      .all()
      .map((row) => [row.item_id, row.count])
  );
};

/** The kept shares of an entry inside a deleted folder: on the entry itself, or under it. */
const underEntry = (kept, entryPath) =>
  kept.filter(
    (snapshot) => snapshot.relative === entryPath || snapshot.relative.startsWith(`${entryPath}/`)
  );

/**
 * Where the content a share was on now starts: the source path of the item
 * (or of the entry `entryPath` inside it), in its space, as it was deleted.
 */
const originalRoot = (snapshot, entryPath = '') => {
  const path = normalize(snapshot.share.source_path);
  const itemRoot = snapshot.relative ? path.slice(0, -(snapshot.relative.length + 1)) : path;
  return {
    sourceSpace: snapshot.share.source_space,
    sourcePath: entryPath ? `${itemRoot}/${entryPath}` : itemRoot,
  };
};

/** The same place under the name the restore actually used. */
const renamedRoot = (root, restoredName) => {
  const segments = normalize(root.sourcePath).split('/');
  segments[segments.length - 1] = restoredName;
  return { ...root, sourcePath: segments.join('/') };
};

/**
 * Bring kept shares back, pointed at `root` — the space and source path the
 * restored content (the item, or the entry `entryPath` of it) now has — and
 * forget them from the trash. A share that has expired, whose owner is gone, or
 * whose id or link has been taken since, cannot come back and is dropped.
 *
 * @returns {Promise<{restored: number, dropped: number}>}
 */
const reinstate = async (kept, root, { entryPath = '' } = {}) => {
  if (!kept.length) return { restored: 0, dropped: 0 };
  const db = await getDb();
  const now = clock.nowIso();
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const taken = db.prepare('SELECT 1 FROM shares WHERE id = ? OR share_token = ?');
  const forget = db.prepare('DELETE FROM trash_shares WHERE share_id = ?');
  const permit = db.prepare(
    'INSERT OR IGNORE INTO share_permissions (id, share_id, user_id, created_at) VALUES (?, ?, ?, ?)'
  );

  let restored = 0;
  let dropped = 0;
  db.transaction(() => {
    for (const snapshot of kept) {
      const { share } = snapshot;
      forget.run(snapshot.shareId);

      const inner = entryPath
        ? snapshot.relative === entryPath
          ? ''
          : snapshot.relative.slice(entryPath.length + 1)
        : snapshot.relative;
      const expired = share.expires_at && Date.parse(share.expires_at) <= clock.now();
      if (expired || !userExists.get(share.owner_id) || taken.get(share.id, share.share_token)) {
        dropped += 1;
        continue;
      }

      const row = {
        ...share,
        source_space: root.sourceSpace,
        source_path: inner ? `${normalize(root.sourcePath)}/${inner}` : normalize(root.sourcePath),
        updated_at: now,
      };
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO shares (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      ).run(...columns.map((column) => row[column]));
      for (const userId of snapshot.permittedUserIds) {
        if (userExists.get(userId)) permit.run(generateId(), share.id, userId, now);
      }
      restored += 1;
    }
  })();
  return { restored, dropped };
};

/** Let kept shares go for good. */
const discard = async (kept) => {
  if (!kept.length) return 0;
  const db = await getDb();
  const forget = db.prepare('DELETE FROM trash_shares WHERE share_id = ?');
  db.transaction(() => {
    for (const snapshot of kept) forget.run(snapshot.shareId);
  })();
  return kept.length;
};

module.exports = {
  CHOICES,
  suspend,
  listForItem,
  countByItem,
  underEntry,
  originalRoot,
  renamedRoot,
  reinstate,
  discard,
};
