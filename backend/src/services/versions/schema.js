/**
 * Where the file versions keep their books.
 *
 * Kept apart from the service, with no dependency of its own, for the same
 * reason as the trash's schema: the database module creates the tables without
 * requiring a service that itself requires the database.
 *
 * - `version_files`: one row per file that has a history. Files are known by
 *   their path, so a history names the zone its file is in and the path inside
 *   that zone, and follows the file when the application renames, moves, trashes
 *   or restores it. `state` is `live` (the file is there), `trashed` (it went to
 *   the trash, and `trash_item_id` with `trash_entry` say where in it), `orphaned`
 *   (it disappeared outside the application; its versions are then the only copy
 *   left, kept until the retention runs out) or `purging` (on its way out, with
 *   every version). The `current_*` columns describe the content the
 *   application last wrote, which is what tells a save inside an editing session
 *   from a file changed behind its back.
 * - `file_versions`: one row per earlier content. The content itself sits in the
 *   zone it was captured in — `zone_id`, which may differ from the file's own
 *   zone once the file has moved to another disk: nothing is copied for a move.
 *   `state` is `capturing` (written before the disk is touched), `kept`, or
 *   `purging`.
 *
 * A trash item that goes — purged, emptied, expired, evicted, forgotten or lost —
 * takes the histories of what it held with it, through the trigger below, so no
 * deletion path can forget them. A restore moves them back to life first.
 */
const VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS version_files (
    id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    state TEXT NOT NULL,
    trash_item_id TEXT,
    trash_entry TEXT,
    current_sha256 TEXT,
    current_size INTEGER,
    current_mtime_ms REAL,
    current_author_id TEXT,
    current_author_label TEXT,
    current_source TEXT,
    current_session TEXT,
    current_explicit INTEGER NOT NULL DEFAULT 0,
    session_checkpoint_at TEXT,
    restored_at TEXT,
    orphaned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_version_files_path ON version_files(zone_id, relative_path);
  CREATE INDEX IF NOT EXISTS idx_version_files_trash ON version_files(trash_item_id);
  CREATE INDEX IF NOT EXISTS idx_version_files_state ON version_files(state);

  CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES version_files(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL,
    state TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,
    modified_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    author_id TEXT,
    author_label TEXT,
    source TEXT,
    aside INTEGER NOT NULL DEFAULT 0,
    label TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, modified_at);
  CREATE INDEX IF NOT EXISTS idx_file_versions_zone ON file_versions(zone_id);

  CREATE TRIGGER IF NOT EXISTS trash_items_take_versions
  AFTER DELETE ON trash_items
  BEGIN
    UPDATE version_files
       SET state = 'purging',
           trash_item_id = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE trash_item_id = OLD.id;
  END;
`;

module.exports = { VERSIONS_DDL };
