const { getDb } = require('./db');
const logger = require('../utils/logger');
const { normalizeRelativePath } = require('../utils/pathUtils');

/**
 * What finished arriving, so something else can act on it.
 *
 * One row per file, written where the bytes are finally in place and under
 * the name they ended up with — which is not always the name that was asked
 * for, since nothing here overwrites. A reader asks for everything after the
 * last id it saw.
 */

/** Long enough for a consumer to have been down for a weekend. */
const RETENTION_DAYS = 7;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** How many rows may go in before the old ones are looked at again. */
const PRUNE_EVERY = 500;
let sinceLastPrune = PRUNE_EVERY;

const prune = (db) => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM upload_events WHERE at < ?').run(cutoff);
};

/**
 * Note a file that has landed.
 *
 * Never throws: an upload that arrived has arrived, and a row that could not
 * be written is not a reason to tell the person otherwise. The same rule the
 * activity log follows.
 */
const record = async ({ path, size = 0, user = null, via = 'direct' } = {}) => {
  try {
    const target = normalizeRelativePath(path || '');
    if (!target) return;
    const db = await getDb();
    db.prepare(
      'INSERT INTO upload_events (at, path, size, user_id, via) VALUES (?, ?, ?, ?, ?)'
    ).run(new Date().toISOString(), target, Number(size) || 0, user?.id ?? null, String(via));

    sinceLastPrune -= 1;
    if (sinceLastPrune <= 0) {
      sinceLastPrune = PRUNE_EVERY;
      prune(db);
    }
  } catch (error) {
    logger.debug({ err: error }, 'An upload event was not recorded');
  }
};

/**
 * Everything after `since`, oldest first.
 *
 * Oldest first, unlike the activity log's newest-first page: this is read to
 * catch up, and a consumer processes in the order things happened. The cursor
 * returned is the last row *looked at*, not the last one handed over — a
 * reader who may see none of a page still moves past it rather than asking
 * for the same rows for ever.
 */
const readSince = async ({ since = 0, limit } = {}) => {
  const db = await getDb();
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const from = Math.max(0, Number(since) || 0);
  const rows = db
    .prepare('SELECT * FROM upload_events WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(from, size + 1);

  const page = rows.slice(0, size);
  return {
    rows: page,
    cursor: page.length ? page[page.length - 1].id : from,
    more: rows.length > size,
  };
};

module.exports = { record, readSince, RETENTION_DAYS, MAX_LIMIT, DEFAULT_LIMIT };
