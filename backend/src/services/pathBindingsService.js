const { getDb, prepared } = require('./db');
const { normalizeRelativePath } = require('../utils/pathUtils');
const logger = require('../utils/logger');

/**
 * Everything the database ties to a path, moved or forgotten in one place.
 *
 * Files move and disappear; the rows that point at them did not follow. A
 * favorite survived the folder it named, a share kept pointing at a path that
 * no longer existed, and a folder's sort order outlived two or three folders
 * that happened to be created at the same place afterwards. Each of those was
 * handled — or not — wherever someone remembered to, which is why deleting a
 * folder cleaned up the favorites of whoever deleted it and nobody else.
 *
 * These are other people's rows as much as your own, so nothing here filters by
 * user: a folder that is gone is gone for everyone who had bookmarked it.
 */

// Rows keyed by a path, and what the column is called there.
const PATH_TABLES = [
  { table: 'favorites', column: 'path' },
  { table: 'recent_destinations', column: 'path' },
  { table: 'folder_preferences', column: 'path' },
  { table: 'shares', column: 'source_path' },
];

const escapeLikePattern = (value = '') => String(value).replace(/[\\%_]/g, '\\$&');

/**
 * Forget what pointed at a path that no longer exists.
 *
 * @param {string} relativePath
 * @param {object} [options]
 * @param {boolean} [options.includeChildren] Also everything beneath it, which
 *   is what deleting a folder means.
 * @returns {Promise<number>} Rows removed, for logging.
 */
const forgetPath = async (relativePath, { includeChildren = false } = {}) => {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return 0;

  let removed = 0;
  try {
    const db = await getDb();
    const childPattern = `${escapeLikePattern(normalized)}/%`;

    db.transaction(() => {
      for (const { table, column } of PATH_TABLES) {
        const result = includeChildren
          ? prepared(
              db,
              `DELETE FROM ${table} WHERE ${column} = ? OR ${column} LIKE ? ESCAPE '\\'`
            ).run(normalized, childPattern)
          : prepared(db, `DELETE FROM ${table} WHERE ${column} = ?`).run(normalized);
        removed += result.changes;
      }
    })();
  } catch (error) {
    // Losing a favorite is not a reason to fail the deletion that succeeded.
    logger.warn({ err: error, relativePath }, 'Could not clean up bindings for deleted path');
  }

  return removed;
};

/**
 * Follow a path that moved, so what pointed at it still does.
 *
 * Children come along: renaming a folder moves everything inside it, and a
 * favorite two levels down is still the same folder afterwards.
 *
 * A row may already exist at the destination — someone had both folders
 * bookmarked, and one has just taken the other's place. The move is written
 * first as a replace so it wins, then the leftovers are dropped.
 */
const movePath = async (fromPath, toPath, { includeChildren = true } = {}) => {
  const from = normalizeRelativePath(fromPath);
  const to = normalizeRelativePath(toPath);
  if (!from || !to || from === to) return 0;

  let moved = 0;
  try {
    const db = await getDb();
    const childPattern = `${escapeLikePattern(from)}/%`;
    const childOffset = from.length + 2; // SQLite substr is 1-based, past the '/'

    db.transaction(() => {
      for (const { table, column } of PATH_TABLES) {
        moved += prepared(
          db,
          `UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`
        ).run(to, from).changes;

        if (!includeChildren) continue;

        moved += prepared(
          db,
          `UPDATE OR REPLACE ${table}
              SET ${column} = ? || substr(${column}, ?)
            WHERE ${column} LIKE ? ESCAPE '\\'`
        ).run(`${to}/`, childOffset, childPattern).changes;
      }
    })();
  } catch (error) {
    logger.warn({ err: error, fromPath, toPath }, 'Could not follow moved path in bindings');
  }

  return moved;
};

module.exports = {
  forgetPath,
  movePath,
  PATH_TABLES,
};
