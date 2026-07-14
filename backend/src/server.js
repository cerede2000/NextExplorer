/**
 * Server entry point - handles HTTP server lifecycle and process management.
 * This file is responsible for starting the server and should NOT be imported in tests.
 * Tests should import the app directly from ./app.js
 */

// Size the libuv thread pool up front, before any async filesystem work runs.
// Directory listings do one fs.stat per entry through this pool; with the Node
// default of 4 threads those stats queue behind concurrent thumbnail-generation
// fs operations (realpath/stat/rename), which makes folder navigation stall
// while a large media folder is being processed. Overridable via the env var
// (also set in the Docker image); this default only applies when unset.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

const { createApp } = require('./app');
const { port, http, features, address } = require('./config/index');
const logger = require('./utils/logger');
const { printStartupBanner } = require('./utils/startupBanner');
const terminalService = require('./services/terminalService');
const folderSizeManager = require('./services/folderSizeManager');
const performanceDiagnostics = require('./services/performanceDiagnostics');

let server = null;

const startServer = async () => {
  logger.debug('Server initialization started');

  const app = await createApp();

  server = app.listen(port, address, () => {
    const addr = server?.address?.();
    printStartupBanner({
      listenHost: typeof addr === 'object' && addr ? addr.address : address,
      listenPort: typeof addr === 'object' && addr ? addr.port : port,
    });
    logger.info({ port }, 'Server is running');
    logger.debug('HTTP server listen callback executed');
  });

  if (server && typeof server.requestTimeout === 'number') {
    server.requestTimeout = http?.requestTimeoutMs ?? server.requestTimeout;
    logger.info(
      { requestTimeoutMs: server.requestTimeout },
      'HTTP server request timeout configured'
    );
  }

  // Initialize terminal only when enabled and dependencies are available.
  const terminalReady = terminalService.initialize({
    enabled: Boolean(features?.terminal),
  });
  if (terminalReady) {
    terminalService.createWebSocketServer(server);
    logger.debug('Terminal WebSocket server initialized');
  } else {
    logger.warn('Terminal disabled at runtime');
  }

  // Start the folder size indexer worker (no-op unless FOLDER_SIZE_MODE is set).
  // It runs off the Express event loop and keeps the folder_size_index fresh.
  folderSizeManager.start();
  performanceDiagnostics.start();

  // Cleanup on process termination
  const cleanup = async () => {
    logger.info('Shutting down server...');
    terminalService.cleanup();
    performanceDiagnostics.stop();
    await folderSizeManager.stop();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return server;
};

startServer().catch((error) => {
  logger.error({ err: error }, 'Failed to start server');
  process.exit(1);
});

module.exports = {
  get server() {
    return server;
  },
};
