const { getDb } = require('./db');
const logger = require('../utils/logger');

/**
 * The folders a user actually moves things into.
 *
 * The destination picker opens on a list rather than at the root, because the
 * folder someone wants is nearly always one they have used before. Nobody
 * curates that list: it is written by the transfers themselves, so it stays
 * true to how the person really files things.
 *
 * Kept per user. A shared favourite is a deliberate bookmark; this is a trace
 * of one person's habits, and showing someone else's would be both wrong and
 * a small leak of where they work.
 */

const MAX_ENTRIES = 10;

/** Note that a transfer landed here. Never throws: this is a convenience. */
const record = async (userId, relativePath) => {
  if (!userId || typeof relativePath !== 'string' || !relativePath.trim()) return;

  try {
    const db = await getDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO recent_destinations (user_id, path, used_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, path) DO UPDATE SET used_at = excluded.used_at`
    ).run(userId, relativePath, now);

    // Trim to the most recent entries. Done on write so the table cannot grow
    // for a user who never opens the picker.
    db.prepare(
      `DELETE FROM recent_destinations
        WHERE user_id = ?
          AND path NOT IN (
            SELECT path FROM recent_destinations
             WHERE user_id = ?
             ORDER BY used_at DESC
             LIMIT ?
          )`
    ).run(userId, userId, MAX_ENTRIES);
  } catch (error) {
    // A destination that fails to be remembered must never fail the transfer
    // that reached it.
    logger.debug({ err: error, relativePath }, 'Could not record recent destination');
  }
};

/** Most recently used first. */
const list = async (userId) => {
  if (!userId) return [];

  const db = await getDb();
  return db
    .prepare(
      `SELECT path FROM recent_destinations
        WHERE user_id = ?
        ORDER BY used_at DESC
        LIMIT ?`
    )
    .all(userId, MAX_ENTRIES)
    .map((row) => row.path);
};

/** Drop a destination that no longer exists or is no longer reachable. */
const forget = async (userId, relativePath) => {
  if (!userId || !relativePath) return;

  try {
    const db = await getDb();
    db.prepare('DELETE FROM recent_destinations WHERE user_id = ? AND path = ?').run(
      userId,
      relativePath
    );
  } catch (error) {
    logger.debug({ err: error, relativePath }, 'Could not forget recent destination');
  }
};

module.exports = {
  record,
  list,
  forget,
};
