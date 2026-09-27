const pino = require('pino');
const loggingConfig = require('../config/logging');

/**
 * Values that must never reach the log files, wherever they are attached.
 *
 * Individual call sites are careful, but a single `{ headers }` or `{ req }`
 * is enough to write a session cookie or a bearer token in clear text, so the
 * redaction is applied globally rather than trusted to each caller.
 */
const REDACTED_PATHS = [
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  'headers["x-guest-session"]',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'secret',
  '*.password',
  '*.token',
  '*.secret',
];

const logger = pino({
  level: loggingConfig.level,
  base: { service: 'nextExplorer-backend' },
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: loggingConfig.isDebug
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          levelFirst: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

logger.debug({ level: loggingConfig.level }, 'Logger initialized');

// Alias used by some parts of the codebase (and for readability).
logger.warning = logger.warn.bind(logger);

module.exports = logger;
