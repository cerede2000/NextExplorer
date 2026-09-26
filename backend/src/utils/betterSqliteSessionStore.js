const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');
const logger = require('./logger');
const { readIdTokenClaims } = require('./idToken');
const { configureStorage, convertToIncremental } = require('../services/databaseMaintenance');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One provider identity, as a string two of them can be compared by.
 *
 * Both halves are required: a subject is only unique within its issuer, so
 * matching on the subject alone could end the session of somebody else who
 * happens to carry the same one at another provider.
 *
 * The trailing slash goes, on both sides, because the two halves come from two
 * places that disagree about it — `auth_methods` keeps `OIDC_ISSUER` as it was
 * configured, the id token carries the `iss` the provider mints — and the same
 * provider written both ways is the same provider. It is the normalisation
 * discovery already applies (see services/oidcService.js).
 */
const identityKey = (issuer, subject) => {
  if (typeof issuer !== 'string' || !issuer.trim()) return null;
  if (typeof subject !== 'string' || !subject.trim()) return null;
  return `${issuer.trim().replace(/\/+$/, '')}\n${subject.trim()}`;
};

class BetterSqliteSessionStore extends session.Store {
  constructor(filename) {
    super();

    this.filename = filename;
    this.db = null;
  }

  /**
   * Opened on first use, not when this module is required.
   *
   * Opening it creates the cache directory and the database in it, which turns
   * requiring this file into a filesystem write — one that fails wherever the
   * cache is not there yet, including the check that every module loads. A
   * process that has not been asked to hold a session has no business creating
   * a place to hold one either.
   */
  ready() {
    if (this.db) return this;

    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.db = new Database(this.filename);
    this.db.pragma('busy_timeout = 5000');
    // Every expired session the daily cleanup deletes leaves its pages behind,
    // and SQLite keeps them: a burst of logins — a script, a scan — grew the
    // file for good. Kept like app.db, so the maintenance pass hands them back.
    configureStorage(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expired INTEGER NOT NULL,
        sess TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);
    convertToIncremental(this.db);

    this.getStatement = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired >= ?');
    this.setStatement = this.db.prepare(
      'INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)'
    );
    this.destroyStatement = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStatement = this.db.prepare(
      'UPDATE sessions SET expired = ? WHERE sid = ? AND expired >= ?'
    );
    this.clearStatement = this.db.prepare('DELETE FROM sessions');
    this.lengthStatement = this.db.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE expired >= ?'
    );
    this.allStatement = this.db.prepare('SELECT sess FROM sessions WHERE expired >= ?');
    this.cleanupStatement = this.db.prepare('DELETE FROM sessions WHERE expired < ?');
    // `localUserId` is what signing in writes onto the session (routes/auth.js).
    // The CASE comes first so a row that is not JSON is skipped rather than
    // failing the whole statement: json_extract raises on malformed input, and
    // SQLite promises no order for the terms of an AND. `IS NOT` so that no
    // exception given still matches every row, where `<> NULL` would match none.
    this.destroyByUserStatement = this.db.prepare(
      `DELETE FROM sessions
       WHERE CASE WHEN json_valid(sess) THEN json_extract(sess, '$.localUserId') END = ?
         AND sid IS NOT ?`
    );
    // A session the identity provider opened carries its tokens and no account
    // id: express-openid-connect stores the token set under `data`. The id
    // token is the only thing in the row that says who signed in, so the rows
    // are read back rather than matched in SQL. Same `json_valid` guard, and
    // the same `IS NOT` for a missing exception.
    this.providerSessionsStatement = this.db.prepare(
      `SELECT sid, CASE WHEN json_valid(sess) THEN json_extract(sess, '$.data.id_token') END AS idToken
       FROM sessions
       WHERE CASE WHEN json_valid(sess) THEN json_extract(sess, '$.data.id_token') END IS NOT NULL
         AND sid IS NOT ?`
    );

    this.cleanupExpiredSessions();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), ONE_DAY_MS);
    this.cleanupTimer.unref();
    return this;
  }

  callback(callback, error, value) {
    process.nextTick(() => callback(error, value));
  }

  expiresAt(sessionData) {
    const cookie = sessionData?.cookie || {};
    const expires = cookie.expires ? new Date(cookie.expires).getTime() : NaN;
    if (Number.isFinite(expires)) return expires;

    const maxAge = Number(cookie.maxAge);
    return Number.isFinite(maxAge) ? Date.now() + maxAge : Date.now() + ONE_DAY_MS;
  }

  cleanupExpiredSessions() {
    this.ready();
    try {
      this.cleanupStatement.run(Date.now());
    } catch (error) {
      logger.warn({ err: error }, 'Unable to clean expired SQLite sessions');
    }
  }

  get(sid, callback = () => {}) {
    this.ready();
    try {
      const row = this.getStatement.get(sid, Date.now());
      this.callback(callback, null, row ? JSON.parse(row.sess) : undefined);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    this.ready();
    try {
      this.setStatement.run(sid, this.expiresAt(sessionData), JSON.stringify(sessionData));
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  destroy(sid, callback = () => {}) {
    this.ready();
    try {
      this.destroyStatement.run(sid);
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  /**
   * End every session signed in to one account, except the one named.
   *
   * Synchronous, unlike the methods express-session calls, and on purpose: the
   * caller changing a password ends the sessions and writes the new hash in the
   * same turn, so no sign-in with the old password can land between the two.
   *
   * Sessions opened by signing in here carry the account id. One opened by the
   * identity provider carries its tokens instead, so the account it belongs to
   * is the subject of its id token — which only the caller can turn into an
   * account, through `auth_methods`. It therefore hands the identities in.
   *
   * @param {string} userId
   * @param {string|null} [exceptSid] the session to keep, usually the caller's
   * @param {Array<{issuer: string|null, subject: string|null}>} [providerIdentities]
   *   the provider identities of the same account. An empty list ends only the
   *   sessions opened by signing in here.
   * @returns {number} how many sessions were ended
   */
  destroyByUser(userId, exceptSid = null, providerIdentities = []) {
    this.ready();
    // No guard needed for a missing id: NULL equals nothing in SQL, and no
    // session carries an empty one.
    const ended = this.destroyByUserStatement.run(userId, exceptSid || null).changes;
    return ended + this.destroyProviderSessions(providerIdentities, exceptSid);
  }

  /**
   * End the sessions the identity provider opened for these identities.
   *
   * A row whose id token cannot be read names nobody, and is left alone: it
   * may belong to another account, and ending it on a guess would sign a
   * stranger out. One unreadable row does not stop the ones after it either —
   * the point of the pass is that a password change ends what it can.
   *
   * @param {Array<{issuer: string|null, subject: string|null}>} providerIdentities
   * @param {string|null} exceptSid
   * @returns {number} how many sessions were ended
   */
  destroyProviderSessions(providerIdentities, exceptSid = null) {
    this.ready();
    const wanted = new Set(
      (Array.isArray(providerIdentities) ? providerIdentities : [])
        .map((identity) => identityKey(identity?.issuer, identity?.subject))
        .filter(Boolean)
    );
    if (wanted.size === 0) return 0;

    let ended = 0;
    for (const row of this.providerSessionsStatement.all(exceptSid || null)) {
      const claims = readIdTokenClaims(row.idToken);
      const key = identityKey(claims?.iss, claims?.sub);
      if (!key || !wanted.has(key)) continue;
      ended += this.destroyStatement.run(row.sid).changes;
    }
    return ended;
  }

  touch(sid, sessionData, callback = () => {}) {
    this.ready();
    try {
      this.touchStatement.run(this.expiresAt(sessionData), sid, Date.now());
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  clear(callback = () => {}) {
    this.ready();
    try {
      this.clearStatement.run();
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  length(callback = () => {}) {
    this.ready();
    try {
      this.callback(callback, null, this.lengthStatement.get(Date.now()).count);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  all(callback = () => {}) {
    this.ready();
    try {
      const sessions = this.allStatement.all(Date.now()).map((row) => JSON.parse(row.sess));
      this.callback(callback, null, sessions);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  close() {
    if (!this.db) return;
    clearInterval(this.cleanupTimer);
    this.db.close();
  }
}

module.exports = { BetterSqliteSessionStore };
