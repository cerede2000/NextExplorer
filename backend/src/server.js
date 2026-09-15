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
const { cleanupExpiredShares } = require('./services/sharesService');
const { cleanupExpiredSessions } = require('./services/guestSessionService');
const { purgeExpiredDocumentKeys } = require('./services/onlyofficeDocumentKeyService');
const terminalService = require('./services/terminalService');
const folderSizeManager = require('./services/folderSizeManager');
const searchIndexManager = require('./services/searchIndexManager');
const performanceDiagnostics = require('./services/performanceDiagnostics');
const { reportOrphanedBindings } = require('./services/orphanedBindingsService');
const { reportLegacyCache } = require('./services/legacyCacheCheck');
const { sweepInterrupted } = require('./services/inFlightFiles');
const trashMaintenance = require('./services/trash/maintenance');
const databaseMaintenance = require('./services/databaseMaintenance');
const tusUploads = require('./services/tusUploadService');
const { installProcessFailureHandlers } = require('./utils/processFailures');

let server = null;

const startServer = async () => {
  logger.debug('Server initialization started');

  // Before anything writes: what operations a stop interrupted left behind.
  sweepInterrupted();

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
  searchIndexManager.start();
  performanceDiagnostics.start();
  // Finishes what a crash interrupted before anything else touches a zone,
  // then keeps each zone within its retention and budget.
  trashMaintenance.start();
  // Chunked uploads abandoned, or finished and never moved into place, leave
  // the upload cache once past TUS_INCOMPLETE_UPLOAD_TTL_MS.
  tusUploads.startCacheSweep();
  // Hands the database's free space back to the filesystem once there is
  // enough of it to matter, so that /config and its backups do not keep it.
  databaseMaintenance.start();

  // Expired shares and guest sessions were never purged: the services had a
  // cleanup function each, and nothing ever called them, so both tables grew
  // forever and an expired share stayed on disk indefinitely.
  const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const sweepExpiredRecords = async () => {
    try {
      const [shares, sessions, documentKeys] = await Promise.all([
        cleanupExpiredShares(),
        cleanupExpiredSessions(),
        purgeExpiredDocumentKeys(),
      ]);
      if (shares || sessions || documentKeys) {
        logger.info(
          { shares, sessions, documentKeys },
          'Purged expired shares, guest sessions and ONLYOFFICE document keys'
        );
      }
    } catch (error) {
      logger.warn({ err: error }, 'Expiry sweep failed');
    }
  };
  const expirySweep = setInterval(sweepExpiredRecords, EXPIRY_SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  expirySweep.unref?.();
  sweepExpiredRecords();

  // Say what points at a volume that is not there. Removing nothing is the
  // whole point: an unmounted volume and a deleted one look identical from
  // here, and only a person can tell them apart.
  reportOrphanedBindings();
  // And what releases before 2.0.3 left in the cache directory: an old app.db
  // nothing reads, or the links 1.1.8 left beside it.
  reportLegacyCache();

  // Cleanup on process termination
  const cleanup = async () => {
    logger.info('Shutting down server...');
    clearInterval(expirySweep);
    terminalService.cleanup();
    performanceDiagnostics.stop();
    trashMaintenance.stop();
    await tusUploads.stopCacheSweep();
    databaseMaintenance.stop();
    await folderSizeManager.stop();
    searchIndexManager.stop();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Installed last, so the shutdown it may need already exists.
  installProcessFailureHandlers({ onFatal: cleanup });

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
