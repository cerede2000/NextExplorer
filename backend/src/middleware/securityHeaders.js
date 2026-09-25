const logger = require('../utils/logger');

/**
 * Baseline security response headers.
 *
 * These are deliberately conservative: they harden how a browser treats our
 * responses without constraining what the application itself may load, so no
 * content policy has to be tuned alongside the frontend build. Routes that
 * serve user content add their own stricter headers (see files/preview and the
 * share download routes).
 *
 * Not set here:
 * - Content-Security-Policy, which would need to be kept in sync with the Vue
 *   build (inline styles, blob/data URLs for previews and thumbnails).
 * - HSTS, which is the reverse proxy's decision: the app cannot know whether
 *   every hostname it answers on is HTTPS-only, and a wrong max-age is not
 *   something a user can undo.
 */
const SECURITY_HEADERS = {
  // Do not let the browser guess a type we did not declare.
  'X-Content-Type-Options': 'nosniff',
  // The app has no reason to be framed by another site (clickjacking).
  'X-Frame-Options': 'SAMEORIGIN',
  // Keep full URLs (which contain paths and share tokens) off cross-origin
  // requests, while staying useful for same-origin navigation.
  'Referrer-Policy': 'same-origin',
  // Opt out of browser features the app never uses.
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  // Search engines must not index a private file browser.
  'X-Robots-Tag': 'noindex, nofollow',
};

const configureSecurityHeaders = (app) => {
  // Express advertises itself by default; there is no reason to name the stack.
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    Object.entries(SECURITY_HEADERS).forEach(([header, value]) => {
      // Never overwrite a stricter header a route already decided on.
      if (!res.getHeader(header)) res.setHeader(header, value);
    });
    next();
  });

  logger.debug('Security headers middleware configured');
};

module.exports = { configureSecurityHeaders, SECURITY_HEADERS };
