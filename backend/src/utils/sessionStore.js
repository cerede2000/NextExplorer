const path = require('path');
const logger = require('../utils/logger');
const { directories } = require('../config/index');
const { BetterSqliteSessionStore } = require('./betterSqliteSessionStore');

const cacheDir = (directories && directories.cache) || '/cache';
const dbPath = path.join(cacheDir, 'sessions.db');

const baseStore = new BetterSqliteSessionStore(dbPath);

logger.debug({ dbPath }, 'Initialized shared better-sqlite3 session store');

const localStore = baseStore;

// express-openid-connect may call a store method without a callback. Keep a
// callback-safe facade so OIDC and local authentication use the same sessions.
const oidcStore = {
  get(sid, cb) {
    return baseStore.get(sid, typeof cb === 'function' ? cb : () => {});
  },
  set(sid, sess, cb) {
    return baseStore.set(sid, sess, typeof cb === 'function' ? cb : () => {});
  },
  destroy(sid, cb) {
    return baseStore.destroy(sid, typeof cb === 'function' ? cb : () => {});
  },
};

module.exports = {
  BetterSqliteSessionStore,
  localStore,
  oidcStore,
  dbPath,
};
