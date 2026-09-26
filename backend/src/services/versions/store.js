/**
 * The file versions' rows, and nothing else.
 *
 * Every function takes the database handle, so a caller can group several in
 * one transaction — a capture confirmed and the file's current content recorded
 * are one write, not two.
 */
const clock = require('../trash/clock');

const mapFile = (row) =>
  row
    ? {
        id: row.id,
        zoneId: row.zone_id,
        relativePath: row.relative_path,
        state: row.state,
        trashItemId: row.trash_item_id,
        trashEntry: row.trash_entry,
        currentSha256: row.current_sha256,
        currentSize: row.current_size === null ? null : Number(row.current_size),
        currentMtimeMs: row.current_mtime_ms === null ? null : Number(row.current_mtime_ms),
        currentAuthorId: row.current_author_id,
        currentAuthorLabel: row.current_author_label,
        currentSource: row.current_source,
        currentSession: row.current_session,
        currentExplicit: Boolean(row.current_explicit),
        sessionCheckpointAt: row.session_checkpoint_at,
        restoredAt: row.restored_at,
        orphanedAt: row.orphaned_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapVersion = (row) =>
  row
    ? {
        id: row.id,
        fileId: row.file_id,
        zoneId: row.zone_id,
        state: row.state,
        size: Number(row.size_bytes) || 0,
        sha256: row.sha256,
        modifiedAt: row.modified_at,
        capturedAt: row.captured_at,
        authorId: row.author_id,
        authorLabel: row.author_label,
        source: row.source,
        aside: Boolean(row.aside),
        label: row.label,
        pinned: Boolean(row.pinned),
        updatedAt: row.updated_at,
      }
    : null;

const insertFile = (db, file) => {
  const now = clock.nowIso();
  db.prepare(
    `INSERT INTO version_files (id, zone_id, relative_path, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(file.id, file.zoneId, file.relativePath, file.state || 'live', now, now);
  return getFile(db, file.id);
};

const getFile = (db, id) => mapFile(db.prepare('SELECT * FROM version_files WHERE id = ?').get(id));

/** The history of the file at a path, among those in the given states. */
const findFileAt = (db, zoneId, relativePath, states = ['live']) =>
  mapFile(
    db
      .prepare(
        `SELECT * FROM version_files WHERE zone_id = ? AND relative_path = ?
           AND state IN (${states.map(() => '?').join(', ')})
         ORDER BY CASE state WHEN 'live' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
      )
      .get(zoneId, relativePath, ...states)
  );

const listFiles = (db, { zoneId = null, state = null } = {}) => {
  const clauses = [];
  const values = [];
  if (zoneId) {
    clauses.push('zone_id = ?');
    values.push(zoneId);
  }
  if (state) {
    clauses.push('state = ?');
    values.push(state);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM version_files ${where} ORDER BY relative_path, id`)
    .all(...values)
    .map(mapFile);
};

/** What the application just wrote to a file, so its next save can tell what happened in between. */
const recordCurrent = (db, id, current) =>
  db
    .prepare(
      `UPDATE version_files SET
         current_sha256 = ?, current_size = ?, current_mtime_ms = ?,
         current_author_id = ?, current_author_label = ?, current_source = ?,
         current_session = ?, current_explicit = ?, session_checkpoint_at = ?,
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      current.sha256 || null,
      Number.isFinite(current.size) ? current.size : null,
      Number.isFinite(current.mtimeMs) ? current.mtimeMs : null,
      current.authorId || null,
      current.authorLabel || null,
      current.source || null,
      current.session || null,
      current.explicit ? 1 : 0,
      current.checkpointAt || null,
      clock.nowIso(),
      id
    ).changes;

const setFileState = (db, id, state, { orphanedAt = null } = {}) =>
  db
    .prepare('UPDATE version_files SET state = ?, orphaned_at = ?, updated_at = ? WHERE id = ?')
    .run(state, orphanedAt, clock.nowIso(), id).changes;

const setRestoredAt = (db, id, restoredAt) =>
  db
    .prepare('UPDATE version_files SET restored_at = ?, updated_at = ? WHERE id = ?')
    .run(restoredAt, clock.nowIso(), id).changes;

const deleteFile = (db, id) => db.prepare('DELETE FROM version_files WHERE id = ?').run(id).changes;

const insertVersion = (db, version) => {
  const now = clock.nowIso();
  db.prepare(
    `INSERT INTO file_versions (
       id, file_id, zone_id, state, size_bytes, sha256, modified_at, captured_at,
       author_id, author_label, source, aside, label, pinned, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(
    version.id,
    version.fileId,
    version.zoneId,
    version.state || 'capturing',
    Math.max(0, Math.floor(Number(version.size) || 0)),
    version.sha256 || null,
    version.modifiedAt,
    version.capturedAt || now,
    version.authorId || null,
    version.authorLabel || null,
    version.source || null,
    version.aside ? 1 : 0,
    now
  );
  return getVersion(db, version.id);
};

const getVersion = (db, id) =>
  mapVersion(db.prepare('SELECT * FROM file_versions WHERE id = ?').get(id));

/** A file's versions, newest first. */
const listVersionsOfFile = (db, fileId, { states = ['kept'] } = {}) =>
  db
    .prepare(
      `SELECT * FROM file_versions WHERE file_id = ?
         AND state IN (${states.map(() => '?').join(', ')})
       ORDER BY modified_at DESC, captured_at DESC, id`
    )
    .all(fileId, ...states)
    .map(mapVersion);

const listVersionsInZone = (db, zoneId) =>
  db
    .prepare('SELECT * FROM file_versions WHERE zone_id = ? ORDER BY modified_at, id')
    .all(zoneId)
    .map(mapVersion);

const setVersionState = (db, id, state) =>
  db
    .prepare('UPDATE file_versions SET state = ?, updated_at = ? WHERE id = ?')
    .run(state, clock.nowIso(), id).changes;

const setVersionDetails = (db, id, { label, pinned }) => {
  const current = getVersion(db, id);
  if (!current) return 0;
  return db
    .prepare('UPDATE file_versions SET label = ?, pinned = ?, updated_at = ? WHERE id = ?')
    .run(
      label === undefined ? current.label : label || null,
      (pinned === undefined ? current.pinned : pinned) ? 1 : 0,
      clock.nowIso(),
      id
    ).changes;
};

const deleteVersion = (db, id) =>
  db.prepare('DELETE FROM file_versions WHERE id = ?').run(id).changes;

/**
 * Paths, as a LIKE pattern matches them.
 *
 * A folder called `100%_done` is a wildcard to LIKE, and would have matched
 * every sibling. Escaped here rather than at each call site, because there is
 * no reading of a query that makes this optional.
 */
const likeLiteral = (value) => String(value).replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * How many kept versions each file directly inside a folder has.
 *
 * One query for a whole listing, not one per row: a folder of three hundred
 * files costs the same as a folder of three.
 *
 * The range does the work — `relative_path` is the second column of
 * `idx_version_files_path`, and a folder's children all begin with its path
 * and a slash. The bound above it is that same path with `0`, the character
 * after `/`, so nothing outside the folder is read at all. What the range
 * still lets through is the folder's descendants; the `NOT LIKE` drops
 * anything with a further slash, which leaves the direct children.
 *
 * `zoneIds` rather than one zone: a root that has been registered twice over
 * the installation's life has two rows, and a file's history may sit under
 * either.
 */
const countKeptInFolder = (db, zoneIds, folderPath) => {
  const zones = [...new Set((zoneIds || []).filter(Boolean))];
  if (zones.length === 0) return [];

  const prefix = folderPath ? `${folderPath}/` : '';
  const clauses = [
    `vf.zone_id IN (${zones.map(() => '?').join(', ')})`,
    "vf.state = 'live'",
    "vf.relative_path NOT LIKE ? ESCAPE '\\'",
  ];
  const values = [...zones, `${likeLiteral(prefix)}%/%`];
  if (prefix) {
    // `dir/` … `dir0`: '/' is 0x2F and '0' is 0x30, so the pair is exactly the
    // folder's subtree and nothing adjacent to it.
    clauses.push('vf.relative_path >= ?', 'vf.relative_path < ?');
    values.push(prefix, `${folderPath}0`);
  }

  return db
    .prepare(
      `SELECT vf.relative_path AS relativePath,
              COUNT(v.id) AS versions,
              SUM(v.size_bytes) AS bytes,
              MAX(v.modified_at) AS newest
         FROM version_files vf
         JOIN file_versions v ON v.file_id = vf.id AND v.state = 'kept'
        WHERE ${clauses.join(' AND ')}
        GROUP BY vf.id`
    )
    .all(...values)
    .map((row) => ({
      relativePath: row.relativePath,
      versions: Number(row.versions) || 0,
      bytes: Number(row.bytes) || 0,
      newest: row.newest || null,
    }));
};

/** The states a history can be listed in, and the order they are offered in. */
const FILE_STATES = ['live', 'trashed', 'orphaned'];

const ADMIN_SORTS = {
  bytes: 'bytes DESC, vf.relative_path ASC',
  versions: 'versions DESC, bytes DESC, vf.relative_path ASC',
  newest: 'newest DESC, vf.relative_path ASC',
  path: 'vf.relative_path ASC, vf.id ASC',
};

/** What narrows an administrator's list of histories, said once for both queries. */
const adminFilter = ({ zoneId = null, state = null, query = '' } = {}) => {
  const clauses = [];
  const values = [];
  if (zoneId) {
    clauses.push('vf.zone_id = ?');
    values.push(zoneId);
  }
  if (state) {
    clauses.push('vf.state = ?');
    values.push(state);
  } else {
    clauses.push(`vf.state IN (${FILE_STATES.map(() => '?').join(', ')})`);
    values.push(...FILE_STATES);
  }
  const wanted = String(query || '').trim();
  if (wanted) {
    // `instr` and not LIKE: somebody looking for `report_2026` means that
    // underscore, and LIKE would have taken it for any character at all.
    clauses.push('instr(lower(vf.relative_path), lower(?)) > 0');
    values.push(wanted);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
};

/**
 * Every file that has a history, for an administrator.
 *
 * Grouped in the database rather than counted in the application: the answer
 * is one page, and the alternative is reading every version of every file in
 * the installation to show twenty-five rows.
 */
const listFilesWithVersions = (
  db,
  { zoneId = null, state = null, query = '', sort = 'bytes', limit = 25, offset = 0 } = {}
) => {
  const { where, values } = adminFilter({ zoneId, state, query });
  const order = ADMIN_SORTS[sort] || ADMIN_SORTS.bytes;
  return db
    .prepare(
      `SELECT vf.id AS id, vf.zone_id AS zoneId, vf.relative_path AS relativePath,
              vf.state AS state,
              COUNT(v.id) AS versions,
              SUM(v.size_bytes) AS bytes,
              MAX(v.modified_at) AS newest
         FROM version_files vf
         JOIN file_versions v ON v.file_id = vf.id AND v.state = 'kept'
         ${where}
        GROUP BY vf.id
        ORDER BY ${order}
        LIMIT ? OFFSET ?`
    )
    .all(...values, Math.max(1, limit), Math.max(0, offset))
    .map((row) => ({
      id: row.id,
      zoneId: row.zoneId,
      relativePath: row.relativePath,
      state: row.state,
      versions: Number(row.versions) || 0,
      bytes: Number(row.bytes) || 0,
      newest: row.newest || null,
    }));
};

/** How many files the same filter matches, and what they hold altogether. */
const summariseFilesWithVersions = (db, { zoneId = null, state = null, query = '' } = {}) => {
  const { where, values } = adminFilter({ zoneId, state, query });
  const row = db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes,
              COALESCE(SUM(versions), 0) AS versions
         FROM (SELECT vf.id, SUM(v.size_bytes) AS bytes, COUNT(v.id) AS versions
                 FROM version_files vf
                 JOIN file_versions v ON v.file_id = vf.id AND v.state = 'kept'
                 ${where}
                GROUP BY vf.id)`
    )
    .get(...values);
  return {
    files: Number(row?.files) || 0,
    bytes: Number(row?.bytes) || 0,
    versions: Number(row?.versions) || 0,
  };
};

module.exports = {
  mapFile,
  mapVersion,
  insertFile,
  getFile,
  findFileAt,
  listFiles,
  recordCurrent,
  setFileState,
  setRestoredAt,
  deleteFile,
  insertVersion,
  getVersion,
  listVersionsOfFile,
  listVersionsInZone,
  setVersionState,
  setVersionDetails,
  deleteVersion,
  countKeptInFolder,
  listFilesWithVersions,
  summariseFilesWithVersions,
  FILE_STATES,
  ADMIN_SORTS,
};
