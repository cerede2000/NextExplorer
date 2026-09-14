/**
 * Where the trash keeps its books.
 *
 * Kept apart from the service that uses it, with no dependency of its own, so
 * the database module can create the tables without requiring a service that
 * itself requires the database.
 *
 * - `trash_zones`: one row per reserved space the application has created,
 *   identified by the id written in the zone's own marker file. The root is
 *   not unique on purpose: a disk replaced under the same mount point is a new
 *   zone, and the old one's rows must not be mistaken for it.
 * - `trash_items`: one row per deleted entry. `state` is where the entry is in
 *   its cycle — `entering`, `trashed`, `restoring`, `purging` — and every
 *   state but `trashed` is written before the disk is touched, so a crash
 *   leaves something the recovery can finish or undo.
 * - `trash_events`: what the maintenance did that someone may need to see — an
 *   item evicted before its retention, one adopted after a crash, one lost.
 */
const TRASH_DDL = `
  CREATE TABLE IF NOT EXISTS trash_zones (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trash_zones_root ON trash_zones(root);

  CREATE TABLE IF NOT EXISTS trash_items (
    id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL,
    state TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    original_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    logical_path TEXT,
    space TEXT,
    deleted_by TEXT,
    deleted_by_label TEXT,
    owner_user_id TEXT,
    restore_path TEXT,
    deleted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trash_items_zone ON trash_items(zone_id, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_trash_items_deleted_by ON trash_items(deleted_by);
  CREATE INDEX IF NOT EXISTS idx_trash_items_owner ON trash_items(owner_user_id);

  CREATE TABLE IF NOT EXISTS trash_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL,
    item_id TEXT,
    item_name TEXT,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trash_events_zone ON trash_events(zone_id, id);
`;

module.exports = { TRASH_DDL };
