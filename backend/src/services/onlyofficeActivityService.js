const path = require('path');

// This is presence information, not a filesystem lock. Keeping it in memory
// makes it cheap, ephemeral across restarts, and impossible for stale data to
// block a file operation.
const sessionsByPath = new Map();
const SESSION_TTL_MS = 2 * 60 * 1000;
const DOCUMENT_SERVER_TTL_MS = 15 * 60 * 1000;

const keyFor = (absolutePath) => path.resolve(absolutePath);

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
};

const heartbeat = ({ absolutePath, sessionId }) => {
  const entry = getEntry(absolutePath);
  const session = entry?.sessions.get(sessionId);
  if (!session) return false;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
};

const close = ({ absolutePath, sessionId }) => {
  const entry = getEntry(absolutePath);
  if (!entry) return;
  entry.sessions.delete(sessionId);
  if (!cleanup(entry)) sessionsByPath.delete(keyFor(absolutePath));
};

const updateDocumentServerUsers = ({ absolutePath, users }) => {
  if (!absolutePath || !Array.isArray(users)) return;
  const entry = getEntry(absolutePath, true);
  entry.documentServerUsers = [...new Set(users.map((user) => String(user)).filter(Boolean))];
  entry.documentServerSeenAt = Date.now();
};

const clearDocumentServerUsers = ({ absolutePath }) => {
  const entry = getEntry(absolutePath);
  if (!entry) return;
  entry.documentServerUsers = [];
  entry.documentServerSeenAt = 0;
  if (!cleanup(entry)) sessionsByPath.delete(keyFor(absolutePath));
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
};
