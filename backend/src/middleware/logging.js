const pinoHttp = require('pino-http');
const { logging } = require('../config/index');
const logger = require('../utils/logger');
const { sanitizeHttpRequestForLog } = require('../utils/logSanitizer');

const configureHttpLogging = (app) => {
  if (!logging.enableHttpLogging) {
    logger.debug('HTTP logging is disabled');
    return;
  }

  app.use(
    pinoHttp({
      logger: logger.child({ context: 'http' }),
      // pino-http logs the whole request by default: the URL with whatever
      // token its query string carries, and every header, the session cookie
      // included.
      serializers: {
        req: sanitizeHttpRequestForLog,
      },
      customLogLevel: (res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return logging.isDebug ? 'debug' : 'info';
      },
    })
  );

  logger.debug('HTTP logging middleware configured');
};

module.exports = { configureHttpLogging };
