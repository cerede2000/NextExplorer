const path = require('path');
const { EventEmitter } = require('events');

// This is presence information, not a filesystem lock. Keeping it in memory
// makes it cheap, ephemeral across restarts, and impossible for stale data to
// block a file operation.
const sessionsByPath = new Map();
const SESSION_TTL_MS = 2 * 60 * 1000;
const DOCUMENT_SERVER_TTL_MS = 15 * 60 * 1000;
const activityEvents = new EventEmitter();
let activityVersion = 0;
let expirationTimer = null;

const keyFor = (absolutePath) => path.resolve(absolutePath);

const notifyActivityChange = () => {
  activityVersion += 1;
  activityEvents.emit('change', activityVersion);
};

const scheduleExpirationCheck = () => {
  if (expirationTimer) clearTimeout(expirationTimer);

  let soonest = Infinity;
  for (const entry of sessionsByPath.values()) {
    for (const session of entry.sessions.values()) {
      soonest = Math.min(soonest, session.expiresAt);
    }
    if (entry.documentServerSeenAt) {
      soonest = Math.min(soonest, entry.documentServerSeenAt + DOCUMENT_SERVER_TTL_MS);
    }
  }

  if (!Number.isFinite(soonest)) {
    expirationTimer = null;
    return;
  }

  expirationTimer = setTimeout(
    () => {
      expirationTimer = null;
      let changed = false;
      for (const [key, entry] of sessionsByPath) {
        const before = `${entry.sessions.size}:${entry.documentServerUsers.join(',')}`;
        const active = cleanup(entry);
        const after = `${entry.sessions.size}:${entry.documentServerUsers.join(',')}`;
        if (before !== after) changed = true;
        if (!active) sessionsByPath.delete(key);
      }
      if (changed) notifyActivityChange();
      scheduleExpirationCheck();
    },
    Math.max(1, soonest - Date.now())
  );
  expirationTimer.unref?.();
};

const cleanup = (entry, now = Date.now()) => {
  for (const [sessionId, session] of entry.sessions) {
    if (session.expiresAt <= now) entry.sessions.delete(sessionId);
  }
  if (entry.documentServerSeenAt && now - entry.documentServerSeenAt > DOCUMENT_SERVER_TTL_MS) {
    entry.documentServerUsers = [];
    entry.documentServerSeenAt = 0;
  }
  return entry.sessions.size > 0 || entry.documentServerUsers.length > 0;
};

const getEntry = (absolutePath, create = false) => {
  const key = keyFor(absolutePath);
  let entry = sessionsByPath.get(key);
  if (!entry && create) {
    entry = { sessions: new Map(), documentServerUsers: [], documentServerSeenAt: 0 };
    sessionsByPath.set(key, entry);
    return entry;
  }
  if (entry && !cleanup(entry)) {
    sessionsByPath.delete(key);
    return null;
  }
  return entry;
};

const open = ({ absolutePath, sessionId, user }) => {
  if (!absolutePath || !sessionId) return;
  const entry = getEntry(absolutePath, true);
  entry.sessions.set(sessionId, {
    userId: user?.id ? String(user.id) : null,
    name: user?.name || 'Utilisateur',
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  notifyActivityChange();
  scheduleExpirationCheck();
};

const heartbeat = ({ absolutePath, sessionId }) => {
  const entry = getEntry(absolutePath);
  const session = entry?.sessions.get(sessionId);
  if (!session) return false;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  scheduleExpirationCheck();
  return true;
};

const close = ({ absolutePath, sessionId }) => {
  const entry = getEntry(absolutePath);
  if (!entry) return;
  const removed = entry.sessions.delete(sessionId);
  if (!cleanup(entry)) sessionsByPath.delete(keyFor(absolutePath));
  if (removed) notifyActivityChange();
  scheduleExpirationCheck();
};

const updateDocumentServerUsers = ({ absolutePath, users }) => {
  if (!absolutePath || !Array.isArray(users)) return;
  const entry = getEntry(absolutePath, true);
  const nextUsers = [...new Set(users.map((user) => String(user)).filter(Boolean))];
  const changed =
    nextUsers.length !== entry.documentServerUsers.length ||
    nextUsers.some((user, index) => user !== entry.documentServerUsers[index]);
  entry.documentServerUsers = nextUsers;
  entry.documentServerSeenAt = Date.now();
  if (changed) notifyActivityChange();
  scheduleExpirationCheck();
};

const clearDocumentServerUsers = ({ absolutePath }) => {
  const entry = getEntry(absolutePath);
  if (!entry) return;
  const changed = entry.documentServerUsers.length > 0;
  entry.documentServerUsers = [];
  entry.documentServerSeenAt = 0;
  if (!cleanup(entry)) sessionsByPath.delete(keyFor(absolutePath));
  if (changed) notifyActivityChange();
  scheduleExpirationCheck();
};

const getVersion = () => activityVersion;

// Holds one lightweight request until presence changes or the timeout elapses.
// This keeps multiple browser sessions live without re-listing directories on a
// timer when nobody is editing a document.
const waitForChange = (since, timeoutMs = 25_000, signal) => {
  if (!Number.isInteger(since) || since !== activityVersion) {
    return Promise.resolve({ version: activityVersion, changed: true });
  }

  return new Promise((resolve) => {
    let timeout = null;
    const finish = (changed) => {
      activityEvents.off('change', onChange);
      signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      resolve({ version: activityVersion, changed });
    };
    const onChange = () => finish(true);
    const onAbort = () => finish(false);
    if (signal?.aborted) {
      finish(false);
      return;
    }
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    activityEvents.once('change', onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const get = (absolutePath) => {
  const entry = getEntry(absolutePath);
  if (!entry) return null;
  const sessionUsers = Array.from(entry.sessions.values());
  const knownUsers = new Map(sessionUsers.map((user) => [user.userId, user.name]));
  const users = [
    ...new Set([...entry.documentServerUsers, ...sessionUsers.map((user) => user.userId)]),
  ]
    .filter(Boolean)
    .map((id) => knownUsers.get(id) || 'Utilisateur');
  return {
    active: users.length > 0,
    users: [...new Set(users)],
    count: users.length,
  };
};

module.exports = {
  open,
  heartbeat,
  close,
  updateDocumentServerUsers,
  clearDocumentServerUsers,
  get,
  getVersion,
  waitForChange,
};
