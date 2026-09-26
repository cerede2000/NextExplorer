const { getDb } = require('./db');
const logger = require('../utils/logger');

/**
 * Where a document is, for as long as an editor has it open.
 *
 * The Document Server is handed a token when the editor opens and returns it
 * unchanged with every save, however long the session lasts — so the token says
 * where the document *was*, not where it is. Renaming from the title bar makes
 * that stale immediately, and a save arriving afterwards would recreate the old
 * name beside the new one.
 *
 * These records are what keep the two in step. They were held in memory, which
 * meant a restart mid-edit lost the rename and put the save back under the old
 * name — rare, silent, and impossible to explain after the fact.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const expiryIso = () => new Date(Date.now() + SESSION_TTL_MS).toISOString();

const mapRow = (row) =>
  row
    ? {
        key: row.document_key,
        relativePath: row.relative_path,
        absolutePath: row.absolute_path,
        userId: row.user_id,
        guestSessionId: row.guest_session_id,
        expiresAt: new Date(row.expires_at).getTime(),
      }
    : null;

const create = async ({ sessionId, key, relativePath, absolutePath, userId, guestSessionId }) => {
  const db = await getDb();
  db.prepare(
    `INSERT INTO onlyoffice_editor_sessions
       (id, document_key, relative_path, absolute_path, user_id, guest_session_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, key, relativePath, absolutePath, userId, guestSessionId, expiryIso());
  return sessionId;
};

/**
 * The session, or null when it has expired or never existed.
 *
 * Expiry is enforced on read rather than by a timer: a sweep that never runs —
 * because the process restarted, say — would otherwise keep stale sessions
 * answering for hours.
 */
const get = async (sessionId) => {
  if (!sessionId) return null;
  const db = await getDb();
  const row = db.prepare('SELECT * FROM onlyoffice_editor_sessions WHERE id = ?').get(sessionId);
  if (!row) return null;

  const session = mapRow(row);
  if (session.expiresAt <= Date.now()) {
    db.prepare('DELETE FROM onlyoffice_editor_sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return session;
};

/** Push the expiry back; the document is evidently still open. */
const touch = async (sessionId) => {
  const db = await getDb();
  db.prepare('UPDATE onlyoffice_editor_sessions SET expires_at = ? WHERE id = ?').run(
    expiryIso(),
    sessionId
  );
};

/** Follow the document to its new name, so later saves land on it. */
const move = async (sessionId, { relativePath, absolutePath }) => {
  const db = await getDb();
  db.prepare(
    'UPDATE onlyoffice_editor_sessions SET relative_path = ?, absolute_path = ? WHERE id = ?'
  ).run(relativePath, absolutePath, sessionId);
};

const remove = async (sessionId) => {
  if (!sessionId) return;
  const db = await getDb();
  db.prepare('DELETE FROM onlyoffice_editor_sessions WHERE id = ?').run(sessionId);
};

const purgeExpired = async () => {
  try {
    const db = await getDb();
    db.prepare('DELETE FROM onlyoffice_editor_sessions WHERE expires_at <= ?').run(
      new Date().toISOString()
    );
  } catch (error) {
    // Expired rows are refused on read anyway.
    logger.debug({ err: error }, 'ONLYOFFICE session purge skipped');
  }
};

module.exports = {
  create,
  get,
  touch,
  move,
  remove,
  purgeExpired,
  SESSION_TTL_MS,
};
