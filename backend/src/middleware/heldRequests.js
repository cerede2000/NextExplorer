const logger = require('../utils/logger');

/**
 * Requests that were accepted and never answered.
 *
 * A container was reported unhealthy while the application served pages
 * perfectly: `/healthz` connected and nothing came back, with an event loop
 * whose worst delay over the same minutes was twenty-two milliseconds. Nothing
 * was blocked — a request was being held, and there was no way to find out
 * where, so the cause was argued about instead of read.
 *
 * This says which path, for how long, and — when it finally answers — with
 * what. That is the difference between "something in the middleware chain is
 * holding requests" and "requests to /healthz are held eleven seconds and then
 * answered 302".
 *
 * One timer per request, cleared when the response ends, and a ceiling on how
 * many are reported: a diagnostic for a stuck server must not become the
 * loudest thing in its log.
 */

const HELD_AFTER_MS = 5000;
const MAX_REPORTED = 10;

/**
 * The threshold is a parameter rather than a constant so that a test can hold
 * a request for twenty milliseconds instead of five seconds. Faking the clock
 * instead would stop supertest's own sockets from progressing, and the test
 * would then be measuring the fake.
 */
const createHeldRequestLogger = ({
  heldAfterMs = HELD_AFTER_MS,
  maxReported = MAX_REPORTED,
} = {}) => {
  let reported = 0;

  return (req, res, next) => {
    const startedAt = Date.now();
    let warned = false;

    const timer = setTimeout(() => {
      if (reported >= maxReported) return;
      reported += 1;
      warned = true;
      logger.warn(
        {
          method: req.method,
          path: req.originalUrl || req.url,
          heldMs: Date.now() - startedAt,
          // Whether anything downstream has begun answering. Headers already
          // sent is a slow body; none sent means the route was never reached.
          headersSent: res.headersSent,
          authenticated: Boolean(req.user || req.oidc?.isAuthenticated?.()),
        },
        'Request accepted and not yet answered'
      );
    }, heldAfterMs);
    timer.unref?.();

    res.on('finish', () => {
      clearTimeout(timer);
      if (!warned) return;
      logger.warn(
        {
          method: req.method,
          path: req.originalUrl || req.url,
          heldMs: Date.now() - startedAt,
          statusCode: res.statusCode,
        },
        'A held request finally answered'
      );
    });

    res.on('close', () => clearTimeout(timer));

    next();
  };
};

const heldRequestLogger = createHeldRequestLogger();

module.exports = { heldRequestLogger, createHeldRequestLogger, HELD_AFTER_MS };
