const { getRequestUser } = require('../services/users');
const { auth } = require('../config/index');
const { ForbiddenError } = require('../errors/AppError');
const logger = require('../utils/logger');

/**
 * Whoever a request arrives as, when authentication is switched off.
 *
 * A deployment behind its own front door runs with no accounts at all, and the
 * rest of the application asks who is calling — so it has to be told
 * something.
 */
const ANONYMOUS_USER = {
  id: 'anonymous',
  username: 'anonymous',
  email: 'anonymous@local',
  displayName: 'Anonymous User',
  roles: ['admin'],
};

/**
 * A share link is opened by someone with no account, which is the point of it.
 *
 * Browsing *inside* one is deliberately not on that list: it needs either an
 * account or a guest session, which is the only proof the password was typed.
 */
const isPublicShareRoute = (requestPath) =>
  requestPath.startsWith('/api/share/') && !requestPath.includes('/browse/');

/**
 * The paths an editor's server calls back on, which carry their own signed
 * token and are checked by the route.
 *
 * Open only while the integration is configured — otherwise they are
 * unauthenticated endpoints for no reason.
 */
const isConfiguredIntegrationCallback = (requestPath) => {
  try {
    const { onlyoffice, collabora } = require('../config/index');

    if (
      onlyoffice?.serverUrl &&
      (requestPath.startsWith('/api/onlyoffice/file') ||
        requestPath.startsWith('/api/onlyoffice/callback'))
    ) {
      return true;
    }

    if (collabora?.url && collabora?.secret && requestPath.startsWith('/api/collabora/wopi/')) {
      return true;
    }
  } catch (_) {
    /* an integration that cannot be read about is an integration that is off */
  }

  return false;
};

/** What is answered before anyone is asked to identify themselves. */
const needsNoIdentity = (req, requestPath) => {
  if (!requestPath.startsWith('/api')) return true;
  if (req.method === 'OPTIONS') return true;
  // Feature flags are needed for plugin registration, and the login page draws
  // its branding before anyone has signed in. Neither carries anything private.
  if (requestPath.startsWith('/api/features')) return true;
  if (requestPath === '/api/branding') return true;
  return isConfiguredIntegrationCallback(requestPath);
};

/**
 * Attach the visitor's guest session, when they have a valid one.
 *
 * Enrichment and not a gate: it decides nothing on its own, and every access
 * check downstream reads it for itself.
 */
const attachGuestSession = async (req, requestPath) => {
  const guestSessionId = req.headers['x-guest-session'] || req.cookies?.guestSession;

  if (!guestSessionId) {
    if (requestPath.startsWith('/api/preview') || requestPath.startsWith('/api/thumbnails')) {
      logger.debug(
        {
          path: requestPath,
          hasHeader: Boolean(req.headers['x-guest-session']),
          hasCookie: Boolean(req.cookies?.guestSession),
          cookies: Object.keys(req.cookies || {}),
        },
        'No guest session for preview/thumbnail request'
      );
    }
    return;
  }

  logger.debug(
    {
      source: req.headers['x-guest-session'] ? 'header' : 'cookie',
      sessionId: guestSessionId,
      path: requestPath,
      cookies: Object.keys(req.cookies || {}),
    },
    'Guest session found'
  );

  try {
    const {
      getGuestSession,
      isGuestSessionValid,
      updateGuestSessionActivity,
    } = require('../services/guestSessionService');

    if (!(await isGuestSessionValid(guestSessionId))) {
      logger.debug({ sessionId: guestSessionId }, 'Guest session invalid or expired');
      return;
    }

    req.guestSession = await getGuestSession(guestSessionId);
    await updateGuestSessionActivity(guestSessionId);
    logger.debug(
      { sessionId: guestSessionId, shareId: req.guestSession.shareId, path: requestPath },
      'Guest session validated'
    );
  } catch (err) {
    logger.debug({ err }, 'Guest session validation failed');
  }
};

/** Whether this request carries a session, and of which kind. */
const sessionsOn = (req) => ({
  throughIdentityProvider: Boolean(
    req.oidc && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()
  ),
  throughLocalAccount: Boolean(req.session && req.session.localUserId),
});

/**
 * Attach the account this session belongs to.
 *
 * @throws {ForbiddenError} when the identity provider vouches for somebody this
 *   installation has no account for and does not create accounts on the fly.
 *   A guest or a share link is let through without one; anything else is not,
 *   because every check below asks what this user may do.
 */
const attachAuthenticatedUser = async (req, { throughIdentityProvider, requestPath }) => {
  const user = await getRequestUser(req);
  if (user) req.user = user;
  if (user || !throughIdentityProvider) return;

  if ((auth?.oidc?.autoCreateUsers ?? true) !== false) return;
  if (isPublicShareRoute(requestPath) || req.guestSession) return;

  throw new ForbiddenError('Profile does not exist.');
};

/**
 * Who is calling, and whether they may be here at all.
 *
 * Four questions in order, each answerable on its own: what needs no identity,
 * what runs with no accounts at all, what the visitor's guest session says,
 * and finally what account this session belongs to. Anything that reaches the
 * end is refused.
 *
 * It was one function of forty-six paths, in front of every request the
 * application serves.
 */
const authMiddleware = async (req, res, next) => {
  const requestPath = req.path || '';

  if (needsNoIdentity(req, requestPath)) {
    next();
    return;
  }

  if (auth.enabled === false) {
    req.user = { ...ANONYMOUS_USER };
    next();
    return;
  }

  await attachGuestSession(req, requestPath);

  if (requestPath.startsWith('/api/auth')) {
    next();
    return;
  }

  const { throughIdentityProvider, throughLocalAccount } = sessionsOn(req);
  if (throughIdentityProvider || throughLocalAccount) {
    try {
      await attachAuthenticatedUser(req, { throughIdentityProvider, requestPath });
    } catch (err) {
      if (err && err.isOperational) {
        next(err);
        return;
      }
      /* anything else is a lookup that failed; the checks below still apply */
    }

    // The guest session is kept alongside the user: it is the only proof that
    // this visitor typed the password of a protected share. Dropping it here
    // made that check unsatisfiable for signed-in visitors. Each access check
    // decides on its own, and every one of them prefers the user when both are
    // present, so a stale guest session can no longer shadow user access.
    next();
    return;
  }

  // Reached with no account: a share link is still open to anyone, and a guest
  // session is what a visitor to a protected one carries instead.
  if (isPublicShareRoute(requestPath) || req.guestSession) {
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required.' });
};

module.exports = authMiddleware;
