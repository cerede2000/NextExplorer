const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { directories } = require('../config/index');

/**
 * Strip server-side absolute paths out of a message shown to a client.
 *
 * Errors bubbling up from fs, spawned tools or archive libraries often quote
 * the full path they failed on. Callers only ever address files by relative
 * path, so the host layout is of no use to them — and it tells an anonymous
 * share visitor how the server is organized. The full message is still logged.
 */
const REDACTED_ROOTS = [
  directories?.volume,
  directories?.userRoot,
  directories?.config,
  directories?.cache,
]
  .filter((value) => typeof value === 'string' && value.length > 1)
  // Longest first, so nested roots are replaced by the most specific one.
  .sort((a, b) => b.length - a.length);

const sanitizeClientMessage = (message) => {
  if (typeof message !== 'string' || !message) return message;
  return REDACTED_ROOTS.reduce(
    (text, root) => text.split(root).join('…'),
    message
    // Any remaining absolute path (e.g. a temp dir) keeps only its basename.
  ).replace(/(^|[\s'"(])\/(?:[\w.@ -]+\/)+([\w.@ -]+)/g, '$1…/$2');
};

const isOidcDocumentRequest = (req) => {
  const path = req?.path || '';
  if (path !== '/callback') return false;
  const accept = typeof req.headers?.accept === 'string' ? req.headers.accept : '';
  const secFetchDest =
    typeof req.headers?.['sec-fetch-dest'] === 'string' ? req.headers['sec-fetch-dest'] : '';
  const secFetchMode =
    typeof req.headers?.['sec-fetch-mode'] === 'string' ? req.headers['sec-fetch-mode'] : '';
  return accept.includes('text/html') || secFetchDest === 'document' || secFetchMode === 'navigate';
};

const clearOidcSessionCookies = (res) => {
  // express-openid-connect defaults to "appSession"
  try {
    res.clearCookie('appSession', {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true,
    });
  } catch (_) {
    /* ignore */
  }
  try {
    res.clearCookie('appSession', {
      path: '/',
      sameSite: 'Lax',
      secure: false,
      httpOnly: true,
    });
  } catch (_) {
    /* ignore */
  }
};

/**
 * Centralized error handling middleware
 * Must be registered AFTER all routes in app.js
 *
 * Handles both operational errors (AppError instances) and unexpected errors
 */
// Express only recognizes error middleware when it has 4 args: (err, req, res, next)
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // Generate unique request ID for tracking
  const requestId = uuidv4();

  // Determine if this is an operational error (expected) or programmer error (unexpected)
  const isOperational = err.isOperational || false;
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'An unexpected error occurred';

  // For OIDC callback navigations, redirect back into the SPA so the login screen can show the error.
  // Otherwise, the browser will render the JSON payload as a standalone error page.
  if (!res.headersSent && isOidcDocumentRequest(req)) {
    clearOidcSessionCookies(res);
    const nextUrl = `/auth/login?error=${encodeURIComponent(message)}`;
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, nextUrl);
    return;
  }

  // Build error context for logging
  const errorContext = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    isOperational,
    err,
  };

  // Add user info if available
  if (req.oidc?.user?.email) {
    errorContext.user = req.oidc.user.email;
  } else if (req.session?.user?.username) {
    errorContext.user = req.session.user.username;
  }

  // Log based on severity
  if (statusCode >= 500) {
    // Server errors - always log as error
    logger.error(errorContext, `Server error: ${message}`);
  } else if (statusCode >= 400) {
    // Client errors - log as warning
    logger.warn(errorContext, `Client error: ${message}`);
  } else {
    // Other status codes
    logger.info(errorContext, `Request error: ${message}`);
  }

  // Build response object
  const errorResponse = {
    success: false,
    error: {
      message: sanitizeClientMessage(message),
      statusCode: statusCode,
      requestId: requestId,
      timestamp: new Date().toISOString(),
    },
  };

  // Add additional error details for operational errors
  if (isOperational && err.toJSON) {
    const errorJson = err.toJSON();
    // Merge any additional properties (like details, retryAfter, etc.)
    Object.keys(errorJson).forEach((key) => {
      if (key !== 'message' && key !== 'statusCode' && key !== 'timestamp') {
        errorResponse.error[key] = errorJson[key];
      }
    });
  }

  // In development, include stack trace for debugging
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
    errorResponse.error.stack = err.stack;
  }

  // Send response
  res.status(statusCode).json(errorResponse);
};

/**
 * 404 handler for unmatched routes
 * Should be registered BEFORE the error handler but AFTER all valid routes
 */
const notFoundHandler = (req, res, next) => {
  const NotFoundError = require('../errors/AppError').NotFoundError;
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
};

module.exports = {
  errorHandler,
  notFoundHandler,
};
