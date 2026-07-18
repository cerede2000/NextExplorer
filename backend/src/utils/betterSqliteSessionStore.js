const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');
const logger = require('./logger');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

class BetterSqliteSessionStore extends session.Store {
  constructor(filename) {
    super();

    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expired INTEGER NOT NULL,
        sess TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);

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

    this.cleanupExpiredSessions();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), ONE_DAY_MS);
    this.cleanupTimer.unref();
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
    try {
      this.cleanupStatement.run(Date.now());
    } catch (error) {
      logger.warn({ err: error }, 'Unable to clean expired SQLite sessions');
    }
  }

  get(sid, callback = () => {}) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      this.callback(callback, null, row ? JSON.parse(row.sess) : undefined);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.setStatement.run(sid, this.expiresAt(sessionData), JSON.stringify(sessionData));
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.touchStatement.run(this.expiresAt(sessionData), sid, Date.now());
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.clearStatement.run();
      this.callback(callback, null);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  length(callback = () => {}) {
    try {
      this.callback(callback, null, this.lengthStatement.get(Date.now()).count);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  all(callback = () => {}) {
    try {
      const sessions = this.allStatement.all(Date.now()).map((row) => JSON.parse(row.sess));
      this.callback(callback, null, sessions);
    } catch (error) {
      this.callback(callback, error);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.db.close();
  }
}

module.exports = { BetterSqliteSessionStore };
