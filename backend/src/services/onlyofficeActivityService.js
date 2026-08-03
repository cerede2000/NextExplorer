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

/**
 * Record that someone has this document open, and keep that record alive.
 *
 * One call for both because presence starts when the editor reports the
 * document open, not when its configuration is requested — a document that
 * failed to open used to be shown as being edited, since the marker was placed
 * before anyone knew whether the editor would succeed. The first call from a
 * session creates the record, later ones only extend it.
 *
 * Only the first one notifies: a heartbeat every sixty seconds must not wake
 * every browser waiting on a presence change.
 */
const touch = ({ absolutePath, sessionId, user }) => {
  if (!absolutePath || !sessionId) return false;
  const entry = getEntry(absolutePath, true);
  const existing = entry.sessions.get(sessionId);

  entry.sessions.set(sessionId, {
    userId: existing?.userId ?? (user?.id ? String(user.id) : null),
    name: existing?.name || user?.name || 'Utilisateur',
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  if (!existing) notifyActivityChange();
  scheduleExpirationCheck();
  return true;
};

/**
 * Follow a document that was renamed while open.
 *
 * Presence is keyed by path, so without this the old name would keep showing
 * as being edited until it expired, and the new one would show nothing.
 */
const rename = ({ from, to }) => {
  if (!from || !to) return;
  const fromKey = keyFor(from);
  const entry = sessionsByPath.get(fromKey);
  if (!entry) return;

  sessionsByPath.delete(fromKey);
  const target = getEntry(to, true);
  for (const [sessionId, session] of entry.sessions) {
    target.sessions.set(sessionId, session);
  }
  target.documentServerUsers = [
    ...new Set([...target.documentServerUsers, ...entry.documentServerUsers]),
  ];
  target.documentServerSeenAt = Math.max(target.documentServerSeenAt, entry.documentServerSeenAt);

  notifyActivityChange();
  scheduleExpirationCheck();
};

const close = ({ absolutePath, sessionId }) => {
  const entry = getEntry(absolutePath);
  if (!entry) return;
  const removed = entry.sessions.delete(sessionId);
  if (!cleanup(entry)) sessionsByPath.delete(keyFor(absolutePath));
  if (removed) notifyActivityChange();
  scheduleExpirationCheck();
};

// The embedded browser can close before Document Server has finished writing
// the document. Only its terminal callback proves that the document is truly
// released, so clear every local presence record for that path at this point.
const release = ({ absolutePath }) => {
  const key = absolutePath ? keyFor(absolutePath) : null;
  if (!key) return;

  const entry = sessionsByPath.get(key);
  if (!entry) return;

  sessionsByPath.delete(key);
  notifyActivityChange();
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
  touch,
  rename,
  close,
  release,
  updateDocumentServerUsers,
  clearDocumentServerUsers,
  get,
  getVersion,
  waitForChange,
};
