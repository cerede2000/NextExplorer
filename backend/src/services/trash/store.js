/**
 * The trash's rows, and nothing else.
 *
 * Every function takes the database handle rather than fetching it, so a
 * caller can group several of them in one transaction — the end of an item and
 * the end of what depends on it are meant to be a single write.
 */
const clock = require('./clock');

const mapZone = (row) => (row ? { id: row.id, root: row.root, createdAt: row.created_at } : null);

const mapItem = (row) =>
  row
    ? {
        id: row.id,
        zoneId: row.zone_id,
        state: row.state,
        name: row.name,
        kind: row.kind,
        size: Number(row.size_bytes) || 0,
        originalPath: row.original_path,
        relativePath: row.relative_path,
        logicalPath: row.logical_path,
        space: row.space,
        deletedBy: row.deleted_by,
        deletedByLabel: row.deleted_by_label,
        ownerUserId: row.owner_user_id,
        restorePath: row.restore_path,
        deletedAt: row.deleted_at,
        updatedAt: row.updated_at,
      }
    : null;

const insertZone = (db, { id, root, createdAt }) => {
  db.prepare('INSERT OR IGNORE INTO trash_zones (id, root, created_at) VALUES (?, ?, ?)').run(
    id,
    root,
    createdAt || clock.nowIso()
  );
  return mapZone(db.prepare('SELECT * FROM trash_zones WHERE id = ?').get(id));
};

const getZone = (db, id) => mapZone(db.prepare('SELECT * FROM trash_zones WHERE id = ?').get(id));

const listZones = (db) =>
  db.prepare('SELECT * FROM trash_zones ORDER BY root, created_at').all().map(mapZone);

const insertItem = (db, item) => {
  const now = clock.nowIso();
  db.prepare(
    `INSERT INTO trash_items (
      id, zone_id, state, name, kind, size_bytes, original_path, relative_path,
      logical_path, space, deleted_by, deleted_by_label, owner_user_id, restore_path,
      deleted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    item.id,
    item.zoneId,
    item.state || 'entering',
    item.name,
    item.kind,
    Math.max(0, Math.floor(Number(item.size) || 0)),
    item.originalPath,
    item.relativePath,
    item.logicalPath || null,
    item.space || null,
    item.deletedBy || null,
    item.deletedByLabel || null,
    item.ownerUserId || null,
    item.deletedAt || now,
    now
  );
  return getItem(db, item.id);
};

const getItem = (db, id) => mapItem(db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id));

const setItemState = (db, id, state, { restorePath = null } = {}) =>
  db
    .prepare('UPDATE trash_items SET state = ?, restore_path = ?, updated_at = ? WHERE id = ?')
    .run(state, restorePath, clock.nowIso(), id).changes;

const setItemSize = (db, id, size) =>
  db
    .prepare('UPDATE trash_items SET size_bytes = ?, updated_at = ? WHERE id = ?')
    .run(Math.max(0, Math.floor(Number(size) || 0)), clock.nowIso(), id).changes;

const deleteItem = (db, id) => db.prepare('DELETE FROM trash_items WHERE id = ?').run(id).changes;

const listItemsByZone = (db, zoneId) =>
  db
    .prepare('SELECT * FROM trash_items WHERE zone_id = ? ORDER BY deleted_at, id')
    .all(zoneId)
    .map(mapItem);

const listItems = (db) =>
  db.prepare('SELECT * FROM trash_items ORDER BY deleted_at DESC, id').all().map(mapItem);

const insertEvent = (db, { zoneId, itemId = null, itemName = null, kind, detail = null }) =>
  db
    .prepare(
      `INSERT INTO trash_events (zone_id, item_id, item_name, kind, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(zoneId, itemId, itemName, kind, detail, clock.nowIso());

const listEvents = (db, { zoneId, limit = 50 } = {}) =>
  db
    .prepare(
      `SELECT id, zone_id, item_id, item_name, kind, detail, created_at
       FROM trash_events WHERE zone_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(zoneId, limit)
    .map((row) => ({
      id: row.id,
      zoneId: row.zone_id,
      itemId: row.item_id,
      itemName: row.item_name,
      kind: row.kind,
      detail: row.detail,
      createdAt: row.created_at,
    }));

module.exports = {
  insertZone,
  getZone,
  listZones,
  insertItem,
  getItem,
  setItemState,
  setItemSize,
  deleteItem,
  listItemsByZone,
  listItems,
  insertEvent,
  listEvents,
};
