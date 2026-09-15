const crypto = require('crypto');
const session = require('express-session');

const { auth: envAuthConfig } = require('../config/index');
const { localStore } = require('../utils/sessionStore');
const logger = require('../utils/logger');

const configureSession = (app) => {
  // The config layer always supplies one — configured, or generated once and
  // kept in CONFIG_DIR — and reading the environment again here would bypass
  // both SESSION_SECRET_FILE and the stored secret.
  const sessionSecret =
    (envAuthConfig && envAuthConfig.sessionSecret) || crypto.randomBytes(32).toString('hex');

  logger.debug({ hasSessionSecret: Boolean(sessionSecret) }, 'Session secret resolved');

  app.locals.sessionStore = localStore;

  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: localStore,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
        maxAge: (envAuthConfig && envAuthConfig.sessionMaxAgeMs) || 30 * 24 * 60 * 60 * 1000, // Default: 30 days
      },
    })
  );

  logger.debug('Express session middleware configured with shared SQLite store');
};

module.exports = { configureSession };
