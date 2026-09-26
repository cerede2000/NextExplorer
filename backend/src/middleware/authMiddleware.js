const { getRequestUser } = require('../services/users');
const { auth } = require('../config/index');
const { ForbiddenError, UnauthorizedError } = require('../errors/AppError');
const logger = require('../utils/logger');
const { applyApiToken } = require('./apiTokenAuth');
const apiTokens = require('../services/apiTokens');

/**
 * Say, once in a while, that a token this server knows was refused.
 *
 * Only tokens it knows: gibberish in an Authorization header is noise anybody
 * can produce, and writing a line for each of those would turn the audit trail
 * into a way to fill a disk. A revoked token still being presented, or one
 * reaching for a door it may not open, is the opposite — it is the thing
 * somebody would want to have been told.
 */
const reportRefusal = async (req, refused) => {
  if (!refused?.tokenId) return;
  if (!apiTokens.shouldReportRefusal(refused.tokenId)) return;
  try {
    // eslint-disable-next-line global-require
    const activityLog = require('../services/activityLog');
    await activityLog.record({
      action: 'sign-in',
      outcome: 'refused',
      actor: refused.name ? `token: ${refused.name}` : 'token',
      target: req.path,
      detail: { via: 'api-token', reason: refused.reason, token: refused.tokenId },
      req,
    });
  } catch (error) {
    logger.debug({ err: error }, 'Could not record a refused API token');
  }
};

/** The one refusal every unusable token gets, whichever way it is unusable. */
const notAValidToken = () =>
  new UnauthorizedError('That API token is not valid.', 'AUTH_TOKEN_INVALID');

/**
 * Authenticate with the API token this request presented, if it presented one.
 *
 * @returns {{authenticated: boolean, error?: Error}} whether the caller is now
 *   known, and what to refuse them with if they are not.
 */
const authenticateWithToken = async (req) => {
  let outcome;
  try {
    outcome = await applyApiToken(req);
  } catch (error) {
    // A token that cannot be checked is not a token that is believed.
    logger.warn({ err: error }, 'An API token could not be checked');
    return { authenticated: false, error: notAValidToken() };
  }

  if (!outcome) return { authenticated: false };

  if (!outcome.ok) {
    await reportRefusal(req, outcome.refused);
    return {
      authenticated: false,
      error:
        outcome.status === 403 ? new ForbiddenError(outcome.error, outcome.code) : notAValidToken(),
    };
  }

  req.apiToken = {
    id: outcome.token.tokenId,
    name: outcome.token.name,
    scope: outcome.token.scope,
    userId: outcome.token.userId,
  };

  const user = await getRequestUser(req);
  if (!user) {
    // The token is good and the account it named is gone. Refused as an
    // invalid token, because from the caller's side that is what it is.
    return { authenticated: false, error: notAValidToken() };
  }

  req.user = user;
  return { authenticated: true };
};

const authMiddleware = async (req, res, next) => {
  // Express matches routes without regard to case, so `/API/volumes` reaches
  // the same handler as `/api/volumes`. Every decision below compares the path
  // with a lower-case prefix, and a path compared as it arrived was answered
  // "not an API route" and waved through with no identity at all. Folded once,
  // here, rather than at each comparison, because the one that gets forgotten
  // is the one that matters.
  const requestPath = (req.path || '').toLowerCase();
  const apiRoute = requestPath.startsWith('/api');
  const isAuthRoute = requestPath.startsWith('/api/auth');
  // Allow public share access routes (single share with token: /api/share/:token/*)
  // Note: /api/shares/* are management endpoints and require authentication.
  // Important: exclude /api/share/:token/browse/* so browse requests still require
  // an authenticated user and/or a valid guest session.
  const isPublicShareRoute =
    requestPath.startsWith('/api/share/') && !requestPath.includes('/browse/');

  if (!apiRoute) {
    next();
    return;
  }

  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  if (auth.enabled === false) {
    // Inject a synthetic anonymous user for features that require user context
    req.user = {
      id: 'anonymous',
      username: 'anonymous',
      email: 'anonymous@local',
      displayName: 'Anonymous User',
      roles: ['admin'],
    };
    next();
    return;
  }

  // Allow public feature flags endpoint (contains no sensitive data)
  // its needed for plugin registrations
  if (requestPath === '/api/features' || requestPath.startsWith('/api/features')) {
    next();
    return;
  }

  // The API's description says what the published documentation says, and
  // carries nothing private: a client reads it before it has a token.
  if (requestPath === '/api/openapi.json') {
    next();
    return;
  }

  // Allow public branding endpoint (no sensitive data, used on login page)
  if (requestPath === '/api/branding') {
    next();
    return;
  }

  // Allow ONLYOFFICE server callbacks and file fetches (token-guarded in route)
  // Only when ONLYOFFICE integration is enabled
  let isOnlyofficeGuest = false;
  try {
    const { onlyoffice } = require('../config/index');
    if (onlyoffice && onlyoffice.serverUrl) {
      isOnlyofficeGuest =
        requestPath.startsWith('/api/onlyoffice/file') ||
        requestPath.startsWith('/api/onlyoffice/callback');
    }
  } catch (_) {
    /* ignore */
  }

  if (isOnlyofficeGuest) {
    next();
    return;
  }

  // Allow Collabora WOPI endpoints (token-guarded in route)
  // Only when Collabora integration is enabled
  let isCollaboraGuest = false;
  try {
    const { collabora } = require('../config/index');
    if (collabora && collabora.url && collabora.secret) {
      isCollaboraGuest = requestPath.startsWith('/api/collabora/wopi/');
    }
  } catch (_) {
    /* ignore */
  }

  if (isCollaboraGuest) {
    next();
    return;
  }

  // A token, if one was presented. Asked before the session, because a script
  // sending one is saying which credential it wants judged: a stale cookie in
  // the same jar must not be what answers for it.
  const byToken = await authenticateWithToken(req);
  if (byToken.error) {
    next(byToken.error);
    return;
  }
  if (byToken.authenticated) {
    next();
    return;
  }

  // Check for guest session (on all routes)
  const guestSessionId = req.headers['x-guest-session'] || req.cookies?.guestSession;
  if (guestSessionId) {
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
      if (await isGuestSessionValid(guestSessionId)) {
        const session = await getGuestSession(guestSessionId);
        req.guestSession = session;
        // Update activity timestamp
        await updateGuestSessionActivity(guestSessionId);

        logger.debug(
          {
            sessionId: guestSessionId,
            shareId: session.shareId,
            path: requestPath,
          },
          'Guest session validated'
        );
      } else {
        logger.debug({ sessionId: guestSessionId }, 'Guest session invalid or expired');
      }
    } catch (err) {
      logger.debug({ err }, 'Guest session validation failed');
    }
  } else if (requestPath.startsWith('/api/preview') || requestPath.startsWith('/api/thumbnails')) {
    logger.debug(
      {
        path: requestPath,
        hasHeader: !!req.headers['x-guest-session'],
        hasCookie: !!req.cookies?.guestSession,
        cookies: Object.keys(req.cookies || {}),
      },
      'No guest session for preview/thumbnail request'
    );
  }

  if (isAuthRoute) {
    next();
    return;
  }

  // Accept either EOC session or local session
  const isEocAuthenticated = Boolean(
    req.oidc && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()
  );
  const hasLocalSession = Boolean(req.session && req.session.localUserId);
  if (isEocAuthenticated || hasLocalSession) {
    try {
      const user = await getRequestUser(req);
      if (user) req.user = user;
      if (isEocAuthenticated && !user && (auth?.oidc?.autoCreateUsers ?? true) === false) {
        // Allow guest/public access without an app user profile.
        if (isPublicShareRoute || req.guestSession) {
          next();
          return;
        }
        throw new ForbiddenError('Profile does not exist.');
      }
    } catch (err) {
      if (err && err.isOperational) {
        next(err);
        return;
      }
      /* ignore */
    }

    // A guest session stays beside the user. For a password-protected share it
    // is the proof that this account typed the password, and dropping it here
    // refused a signed-in visitor on every request after they had. Every
    // access check already prefers the user when both are present.

    next();
    return;
  }

  // Public share routes should be accessible without authentication, but we still
  // tried to attach an authenticated user above (if present) to support
  // user-specific shares opened via share links.
  if (isPublicShareRoute) {
    next();
    return;
  }

  // Allow access if valid guest session exists (for share paths on browse, files, etc.)
  if (req.guestSession) {
    logger.debug('Allowing request with guest session');
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required.' });
};

module.exports = authMiddleware;
