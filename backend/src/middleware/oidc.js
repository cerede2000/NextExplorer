const crypto = require('crypto');
const { auth: eocAuth } = require('express-openid-connect');

const { auth: envAuthConfig, public: publicConfig } = require('../config/index');
const { getOrCreateOidcUser, deriveRolesFromClaims } = require('../services/users');
const { fetchUserInfoClaims } = require('../services/oidcService');
const { oidcStore } = require('../utils/sessionStore');
const { UnauthorizedError } = require('../errors/AppError');
const {
  uniqueOrigins,
  sanitizeReturnTo,
  getConfiguredRequestOrigin,
  absoluteReturnTo,
  callbackUrlForOrigin,
  oidcCookieNamesForOrigin,
  sanitizeOidcPrompt,
} = require('../utils/oidcRedirect');
const logger = require('../utils/logger');

/**
 * Derives baseURL from callbackUrl or PUBLIC_URL
 */
const deriveBaseUrl = (oidc) => {
  try {
    if (oidc.callbackUrl && /^https?:\/\//i.test(oidc.callbackUrl)) {
      const u = new URL(oidc.callbackUrl);
      logger.debug({ baseURL: u.origin, source: 'callbackUrl' }, 'Derived baseURL');
      return u.origin;
    } else if (publicConfig?.url) {
      const u = new URL(publicConfig.url);
      logger.debug({ baseURL: u.origin, source: 'PUBLIC_URL' }, 'Derived baseURL');
      return u.origin;
    }
  } catch (_) {
    logger.debug('Failed to derive baseURL');
  }
  return null;
};

/**
 * Determines if OIDC cookies should be secure based on an origin.
 */
const shouldOidcCookieBeSecure = (baseURL) => {
  try {
    if (baseURL) {
      const u = new URL(baseURL);
      return u.protocol === 'https:';
    }
  } catch (_) {
    // Ignore URL parsing errors
  }
  return false;
};

/**
 * Validates and parses a URL string
 * @returns {URL|null} Parsed URL or null if invalid
 */
const parseUrl = (urlString) => {
  if (!urlString) return null;
  try {
    return new URL(urlString);
  } catch (_) {
    return null;
  }
};

/**
 * Creates a custom logout handler for IdP logout
 * @param {object} options - Configuration options
 * @param {string} options.logoutURL - The IdP logout URL
 * @param {Function} options.getReturnTo - Resolves the validated browser return URL
 * @returns {Function} Express route handler
 */
const clearOidcCookie = (res, name) => {
  const cookieOptions = { path: '/', sameSite: 'Lax', httpOnly: true };
  res.clearCookie(name, { ...cookieOptions, secure: true });
  res.clearCookie(name, { ...cookieOptions, secure: false });
};

const createLogoutHandler = ({ logoutURL, getReturnTo, getSessionCookieName }) => {
  // Pre-validate the logout URL at configuration time
  const parsedLogoutUrl = parseUrl(logoutURL);
  if (!parsedLogoutUrl) {
    logger.warn({ logoutURL }, 'Invalid OIDC_LOGOUT_URL, custom logout handler not configured');
    return null;
  }

  return async (req, res) => {
    const returnTo = getReturnTo(req);
    const idTokenHint = req.oidc?.idToken;
    const sessionCookieName = getSessionCookieName(req);

    try {
      // Clear local session (promisified for proper sequencing)
      if (req.session) {
        await new Promise((resolve) => {
          req.session.destroy((err) => {
            if (err) logger.debug({ err }, 'Session destroy error (non-fatal)');
            resolve();
          });
        });
      }

      // Clear the server-side EOC session while the browser still provides its
      // session cookie. The client-side cookie is cleared below as well.
      if (sessionCookieName in req) {
        req[sessionCookieName] = undefined;
      }

      // Clear both the active origin-scoped cookie and the legacy name from
      // versions that used a shared cookie across origins.
      clearOidcCookie(res, sessionCookieName);
      if (sessionCookieName !== 'appSession') clearOidcCookie(res, 'appSession');

      // Build logout URL with redirect parameter
      // Use post_logout_redirect_uri (OIDC standard) as primary, but also support returnTo for Auth0
      const idpLogoutUrl = new URL(parsedLogoutUrl.toString());
      idpLogoutUrl.searchParams.set('post_logout_redirect_uri', returnTo);
      if (idTokenHint) {
        idpLogoutUrl.searchParams.set('id_token_hint', idTokenHint);
      }

      logger.debug(
        { logoutOrigin: idpLogoutUrl.origin, hasIdTokenHint: Boolean(idTokenHint) },
        'Redirecting to IdP logout URL'
      );
      res.redirect(idpLogoutUrl.toString());
    } catch (e) {
      logger.warn({ err: e }, 'Error during custom logout');
      res.redirect(returnTo);
    }
  };
};

/**
 * Resolves OIDC scopes, ensuring 'openid' is always included
 */
const resolveOidcScopes = (oidc) => {
  const scopes =
    Array.isArray(oidc.scopes) && oidc.scopes.length ? oidc.scopes : ['openid', 'profile', 'email'];

  const scopeParam = Array.from(new Set(['openid', ...scopes])).join(' ');
  logger.debug({ scopes, scopeParam }, 'OIDC scopes resolved');

  return scopeParam;
};

/**
 * Creates the afterCallback handler for user synchronization
 */
const createAfterCallbackHandler = (oidc, envAuthConfig) => {
  return async (req, res, session) => {
    logger.debug('afterCallback: start');

    try {
      const persistIssuer = oidc.issuer;
      const accessToken = session?.access_token;

      const hasOidc = Boolean(req?.oidc);
      logger.debug(
        {
          hasOidc,
          accessTokenPresent: Boolean(accessToken),
          persistIssuer,
        },
        'OIDC user login state'
      );

      let claims = {};

      // Prefer already-decoded user claims if available on req.oidc.user
      const hasReqUser = Boolean(req?.oidc?.user && req.oidc.user.sub);
      logger.debug({ hasReqUser }, 'afterCallback: req.oidc.user presence');

      if (hasReqUser) {
        claims = req.oidc.user;
        logger.debug('afterCallback: using req.oidc.user');
      }

      // Fetch from userinfo endpoint if access token is available
      if (accessToken && persistIssuer) {
        logger.debug('afterCallback: fetching userinfo via direct HTTP');
        const directClaims = await fetchUserInfoClaims({
          issuer: persistIssuer,
          accessToken,
          userInfoURL: oidc.userInfoURL,
        });

        if (directClaims && directClaims.sub) {
          if (hasReqUser && directClaims.sub !== req.oidc.user.sub) {
            throw new UnauthorizedError(
              'OIDC userinfo subject does not match the authenticated user.'
            );
          }
          claims = directClaims;
          logger.debug('afterCallback: direct userinfo fetch succeeded');
        }
      }

      // Fallback to id_token_claims or session.claims
      if ((!claims || !claims.sub) && session?.id_token_claims) {
        logger.debug('afterCallback: falling back to id_token_claims');
        claims = session.id_token_claims;
      } else if ((!claims || !claims.sub) && session?.claims) {
        logger.debug('afterCallback: falling back to session.claims');
        claims = session.claims;
      }

      const sub = typeof claims?.sub === 'string' && claims.sub.trim() ? claims.sub : null;
      if (!sub) {
        throw new UnauthorizedError('OIDC identity is missing a subject claim.');
      }

      // Derive user information from claims
      const email = claims.email || null;
      const emailVerified = claims.email_verified === true;
      const preferredUsername = claims.preferred_username || claims.username || email || sub;
      const displayName = claims.name || preferredUsername || null;
      const roles = deriveRolesFromClaims(claims, envAuthConfig?.oidc?.adminGroups);

      logger.debug(
        { emailVerified, roleCount: roles.length },
        'afterCallback: OIDC claims validated'
      );

      // Persist user to database
      await getOrCreateOidcUser({
        issuer: persistIssuer,
        sub,
        username: preferredUsername,
        displayName,
        email,
        emailVerified,
        roles,
        requireEmailVerified: envAuthConfig?.oidc?.requireEmailVerified || false,
        autoCreateUsers: envAuthConfig?.oidc?.autoCreateUsers ?? true,
      });

      logger.debug('afterCallback: user persisted/synced');
    } catch (e) {
      // If user sync fails, block login only for operational/expected errors
      // (e.g., auto-provision disabled and profile missing).
      if (e && e.isOperational) {
        throw e;
      }
      logger.warn({ err: e }, 'afterCallback user sync failed');
    }

    logger.debug('afterCallback: complete');
    return session;
  };
};

/**
 * Configures Express OpenID Connect (OIDC) authentication
 */
const configureOidc = async (app) => {
  try {
    logger.debug('Configuring Express OpenID Connect');

    const oidc = (envAuthConfig && envAuthConfig.oidc) || {};

    // Resolve configuration
    const scopeParam = resolveOidcScopes(oidc);
    const baseURL = deriveBaseUrl(oidc);
    const sessionSecret =
      (envAuthConfig && envAuthConfig.sessionSecret) ||
      process.env.SESSION_SECRET ||
      crypto.randomBytes(32).toString('hex');

    // Check if OIDC should be enabled
    const eocEnabled = Boolean(
      oidc.enabled && oidc.issuer && oidc.clientId && sessionSecret && baseURL
    );

    logger.debug(
      {
        enabled: eocEnabled,
        issuer: !!oidc.issuer,
        clientId: !!oidc.clientId,
        baseURL: !!baseURL,
      },
      'EOC enablement check'
    );

    if (!eocEnabled) {
      logger.info(
        'Express OpenID Connect not configured (missing issuer/client/baseURL/secret or disabled)'
      );
      logger.debug(
        {
          enabled: Boolean(oidc.enabled),
          hasIssuer: Boolean(oidc.issuer),
          hasClientId: Boolean(oidc.clientId),
          hasSecret: Boolean(sessionSecret),
          hasBaseURL: Boolean(baseURL),
        },
        'EOC configuration details'
      );
      return;
    }

    // PUBLIC_URL remains canonical for links and integrations. OIDC is the
    // exception: every explicitly configured INTERNAL_URL needs its own
    // callback URL so a login can return to the origin where it began.
    const oidcOrigins = uniqueOrigins([baseURL, ...(publicConfig?.origins || [])]);
    const oidcMiddlewares = new Map();
    const oidcCookieNames = new Map();

    for (const origin of oidcOrigins) {
      const cookieSecure = shouldOidcCookieBeSecure(origin);
      const cookieNames = oidcCookieNamesForOrigin(origin);
      oidcCookieNames.set(origin, cookieNames);
      oidcMiddlewares.set(
        origin,
        eocAuth({
          authRequired: false,
          auth0Logout: false,
          idpLogout: false,
          issuerBaseURL: oidc.issuer,
          baseURL: origin,
          clientID: oidc.clientId,
          clientSecret: oidc.clientSecret || undefined,
          secret: sessionSecret,
          authorizationParams: {
            response_type: 'code',
            scope: scopeParam,
          },
          session: {
            store: oidcStore,
            name: cookieNames.session,
            rolling: true,
            // Convert milliseconds to seconds for absoluteDuration
            absoluteDuration: Math.floor(
              ((envAuthConfig && envAuthConfig.sessionMaxAgeMs) || 30 * 24 * 60 * 60 * 1000) / 1000
            ), // Default: 30 days in seconds
            cookie: {
              sameSite: 'Lax',
              secure: cookieSecure,
              httpOnly: true,
            },
          },
          transactionCookie: {
            name: cookieNames.transaction,
            sameSite: 'Lax',
          },
          afterCallback: createAfterCallbackHandler(oidc, envAuthConfig),
          // The native routes always use one baseURL. Register them ourselves
          // after dispatching the request to its matching origin middleware.
          routes: {
            login: false,
            callback: false,
            logout: false,
          },
        })
      );
    }

    const resolveOrigin = (req) => getConfiguredRequestOrigin(req, oidcOrigins) || baseURL;

    // Attach an EOC request/response context selected by the actual, approved
    // browser origin. Unknown hosts deliberately fall back to PUBLIC_URL.
    app.use((req, res, next) => {
      const origin = resolveOrigin(req);
      req.nextExplorerOidcSessionCookieName = oidcCookieNames.get(origin).session;
      oidcMiddlewares.get(origin)(req, res, next);
    });

    const returnToForRequest = (req) =>
      absoluteReturnTo(resolveOrigin(req), req.query?.returnTo || '/auth/login');

    app.get('/login', (req, res, next) => {
      if (!res.oidc || typeof res.oidc.login !== 'function') {
        next(new Error('OIDC is not configured.'));
        return;
      }
      const prompt = sanitizeOidcPrompt(req.query?.prompt);
      res.oidc.login({
        returnTo: sanitizeReturnTo(req.query?.returnTo),
        authorizationParams: {
          redirect_uri: callbackUrlForOrigin(resolveOrigin(req)),
          ...(prompt ? { prompt } : {}),
        },
      });
    });

    const callbackHandler = (req, res, next) => {
      if (!res.oidc || typeof res.oidc.callback !== 'function') {
        next(new Error('OIDC is not configured.'));
        return;
      }
      res.oidc.callback({ redirectUri: callbackUrlForOrigin(resolveOrigin(req)) });
    };
    app.get('/callback', callbackHandler);
    app.post('/callback', callbackHandler);

    if (oidc.logoutURL) {
      const logoutHandler = createLogoutHandler({
        logoutURL: oidc.logoutURL,
        getReturnTo: returnToForRequest,
        getSessionCookieName: (req) => req.nextExplorerOidcSessionCookieName,
      });
      if (logoutHandler) {
        app.get('/logout', logoutHandler);
        logger.debug('Custom OIDC logout handler configured');
      }
    } else {
      app.get('/logout', (req, res, next) => {
        if (!res.oidc || typeof res.oidc.logout !== 'function') {
          next(new Error('OIDC is not configured.'));
          return;
        }
        res.oidc.logout({ returnTo: returnToForRequest(req) });
      });
    }

    logger.info({ origins: oidcOrigins }, 'Express OpenID Connect is configured');
    logger.debug({ origins: oidcOrigins }, 'Origin-aware EOC middleware mounted');
  } catch (e) {
    logger.warn({ err: e }, 'Failed to configure Express OpenID Connect');
  }
};

module.exports = {
  configureOidc,
};
