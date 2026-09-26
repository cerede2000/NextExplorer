const { getDb } = require('../db');

// Lockout policy
const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED || 5);
const LOCKOUT_MINUTES = Number(process.env.AUTH_LOCK_MINUTES || 15);

const getLock = async (key) => {
  const db = await getDb();
  return (
    db.prepare('SELECT failed_count, locked_until FROM auth_locks WHERE key = ?').get(key) || {
      failed_count: 0,
      locked_until: null,
    }
  );
};

const setLock = async (key, failedCount, lockedUntil) => {
  const db = await getDb();
  db.prepare(
    'INSERT INTO auth_locks(key, failed_count, locked_until) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until'
  ).run(key, failedCount, lockedUntil);
};

const clearLock = async (key) => setLock(key, 0, null);

const isLocked = async (key) => {
  const row = await getLock(key);
  if (!row.locked_until) return false;
  const until = new Date(row.locked_until).getTime();
  return Number.isFinite(until) && Date.now() < until;
};

const incrementFailedAttempts = async (key) => {
  const current = await getLock(key);
  const failed = (Number(current.failed_count) || 0) + 1;
  let lockedUntil = null;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
  }
  await setLock(key, failed, lockedUntil);
};

/**
 * The accounts locked right now, as a map of key to the moment each frees
 * itself.
 *
 * For the administration screen, which had no way to tell a locked account from
 * one whose owner forgot the password. A lock whose time has passed is left
 * out: it refuses nothing any more, and the next sign-in clears it.
 */
const listActiveLocks = async () => {
  const db = await getDb();
  const now = Date.now();
  const locks = new Map();
  const rows = db
    .prepare('SELECT key, locked_until FROM auth_locks WHERE locked_until IS NOT NULL')
    .all();
  for (const row of rows) {
    const until = Date.parse(row.locked_until);
    if (Number.isFinite(until) && until > now) locks.set(row.key, row.locked_until);
  }
  return locks;
};

module.exports = {
  getLock,
  clearLock,
  isLocked,
  incrementFailedAttempts,
  listActiveLocks,
};
