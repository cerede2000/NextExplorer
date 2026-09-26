/**
 * Express application factory.
 * This file defines routes and middleware and exports a createApp function.
 * It does NOT start the server - that's handled by server.js
 *
 * This separation allows tests to import the app without starting a real server.
 */
const express = require('express');
const cookieParser = require('cookie-parser');

const { configureTrustProxy } = require('./middleware/trustProxy');
const { configureSecurityHeaders } = require('./middleware/securityHeaders');
const { configureHttpLogging } = require('./middleware/logging');
const { configureCors } = require('./middleware/cors');
const { configureOidc } = require('./middleware/oidc');
const { configureHttpsWarning } = require('./middleware/httpsWarning');
const { requestContextMiddleware } = require('./utils/requestContext');
const { forwardedAddressWarning } = require('./utils/clientAddress');
const authMiddleware = require('./middleware/authMiddleware');
const registerRoutes = require('./routes');
const { configureStaticFiles } = require('./utils/staticServer');
const { bootstrap } = require('./utils/bootstrap');
const { configureSession } = require('./middleware/session');
const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { uploads } = require('./config');

/**
 * Creates and configures the Express application.
 * @param {Object} options - Configuration options for testing
 * @param {boolean} options.skipBootstrap - Skip bootstrap for unit tests
 * @param {boolean} options.skipOidc - Skip OIDC configuration for unit tests
 * @param {boolean} options.skipSession - Skip session configuration for unit tests
 * @param {boolean} options.skipStaticFiles - Skip static file serving for unit tests
 * @returns {Promise<express.Application>} Configured Express app
 */
const createApp = async (options = {}) => {
  const {
    skipBootstrap = false,
    skipOidc = false,
    skipSession = false,
    skipStaticFiles = false,
  } = options;

  logger.debug('Application initialization started');

  const app = express();

  configureTrustProxy(app);
  // Says once, on the first request that shows it, when a proxy is announcing
  // a client this server was not told to believe: without it every recorded
  // address is the proxy's and nothing anywhere says why.
  app.use(forwardedAddressWarning);
  configureSecurityHeaders(app);
  configureHttpLogging(app);

  configureCors(app);
  // Large enough to carry back whatever the text editor was allowed to open;
  // see the reasoning beside the two limits in the configuration.
  app.use(express.json({ limit: uploads.maxJsonBodyBytes }));
  app.use(express.urlencoded({ extended: true, limit: uploads.maxJsonBodyBytes }));
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  logger.debug('Mounted cookie parser middleware');

  if (!skipBootstrap) {
    await bootstrap();
  }

  if (!skipSession) {
    configureSession(app);
  }

  if (!skipOidc) {
    await configureOidc(app);
  }

  configureHttpsWarning(app);

  app.use(authMiddleware);
  logger.debug('Mounted auth middleware');

  registerRoutes(app);
  logger.debug('Registered application routes');

  if (!skipStaticFiles) {
    configureStaticFiles(app);
  }

  // Error handling middleware (must be after all routes)
  app.use(notFoundHandler);
  app.use(errorHandler);
  logger.debug('Mounted error handling middleware');

  return app;
};

module.exports = {
  createApp,
};
