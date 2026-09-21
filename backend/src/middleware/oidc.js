const crypto = require('crypto');
const { auth: eocAuth } = require('express-openid-connect');

const { auth: envAuthConfig, public: publicConfig } = require('../config/index');
const {
  getOrCreateOidcUser,
  deriveRolesFromClaims,
  rolesFromClaimsAreAuthoritative,
} = require('../services/users');
const { fetchUserInfoClaims } = require('../services/oidcService');
const { oidcStore } = require('../utils/sessionStore');
const { UnauthorizedError } = require('../errors/AppError');
const logger = require('../utils/logger');

/**
 * The address a sign-out ends on, from what the request asked for.
 *
 * Only a path on this site: the value comes from the query string, and it is
 * where the browser is sent once the provider has signed the person out — or
 * straight away, when building the provider's address fails. Anything that is
 * not a plain same-site path becomes the sign-in page.
 */
const sameSiteReturnTo = (candidate, baseURL) => {
  const fallback = '/auth/login';
  let pathOnSite = fallback;
  if (typeof candidate === 'string') {
    const value = candidate.trim();
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
      pathOnSite = value;
    }
  }
  return baseURL ? `${baseURL}${pathOnSite}` : pathOnSite;
};

/**
 * The claims inside an id token, read without checking its signature — the
 * library has already verified it, nonce included, before the after-callback
 * handler is handed the session. Anything that is not a JWT reads as none.
 */
const claimsFromIdToken = (idToken) => {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

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
 * Determines if OIDC cookies should be secure based on baseURL
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
 * @param {string} options.baseURL - The application base URL
 * @param {boolean} options.cookieSecure - Whether cookies should be secure
 * @returns {Function} Express route handler
 */
const createLogoutHandler = ({ logoutURL, baseURL, cookieSecure }) => {
  // Pre-validate the logout URL at configuration time
  const parsedLogoutUrl = parseUrl(logoutURL);
  if (!parsedLogoutUrl) {
    logger.warn({ logoutURL }, 'Invalid OIDC_LOGOUT_URL, custom logout handler not configured');
    return null;
  }

  return async (req, res) => {
    // Calculate returnTo early for use in both success and error paths
    const returnTo = sameSiteReturnTo(req.query.returnTo, baseURL);

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

      // Clear EOC session cookie (both secure variants for robustness)
      const cookieOptions = { path: '/', sameSite: 'Lax', httpOnly: true };
      res.clearCookie('appSession', { ...cookieOptions, secure: cookieSecure });
      res.clearCookie('appSession', { ...cookieOptions, secure: false });

      // Build logout URL with redirect parameter
      // Use post_logout_redirect_uri (OIDC standard) as primary, but also support returnTo for Auth0
      const idpLogoutUrl = new URL(parsedLogoutUrl.toString());
      idpLogoutUrl.searchParams.set('post_logout_redirect_uri', returnTo);

      logger.debug({ logoutUrl: idpLogoutUrl.toString() }, 'Redirecting to IdP logout URL');
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

      // Who this sign-in is, as the provider's id token says — verified by the
      // library by the time this runs. `req.oidc.user` is not it: during the
      // callback it is still the user of the session the browser arrived with,
      // if it had one.
      const idTokenClaims =
        claimsFromIdToken(session?.id_token) || session?.id_token_claims || session?.claims || null;
      let claims = idTokenClaims || {};

      // Fetch from userinfo endpoint if access token is available
      if (accessToken && persistIssuer) {
        logger.debug('afterCallback: fetching userinfo via direct HTTP');
        const directClaims = await fetchUserInfoClaims({
          issuer: persistIssuer,
          accessToken,
          userInfoURL: oidc.userInfoURL,
        });

        if (directClaims && directClaims.sub) {
          // OpenID Connect Core 5.3.2: the userinfo response describes the
          // subject of the id token, or it must not be used at all.
          if (idTokenClaims?.sub && directClaims.sub !== idTokenClaims.sub) {
            throw new UnauthorizedError(
              'OIDC userinfo subject does not match the authenticated user.'
            );
          }
          claims = directClaims;
          logger.debug('afterCallback: direct userinfo fetch succeeded');
        } else if (idTokenClaims?.sub) {
          // A provider whose userinfo is briefly unavailable: the id token
          // already names the person, so the sign-in goes ahead on it.
          logger.debug('afterCallback: userinfo unavailable, using the id token claims');
        }
      }

      const sub = claims && claims.sub ? claims.sub : null;
      if (!sub) {
        logger.debug('afterCallback: no usable claims found; skipping user sync');
        return session;
      }

      // Derive user information from claims
      const email = claims.email || null;
      // Only a boolean true is a verified address. `"false"` is a non-empty
      // string, and read as truthy it attached a sign-in to whichever account
      // already held that address.
      const emailVerified = claims.email_verified === true;
      const preferredUsername = claims.preferred_username || claims.username || email || sub;
      const displayName = claims.name || preferredUsername || null;
      const adminGroups = envAuthConfig?.oidc?.adminGroups;
      const roles = deriveRolesFromClaims(claims, adminGroups);
      // The provider only gets to decide who is an administrator here where an
      // admin group was configured and the provider actually said something
      // about groups. Otherwise the roles already stored are left alone.
      const rolesAreAuthoritative = rolesFromClaimsAreAuthoritative(claims, adminGroups);

      logger.debug(
        {
          sub,
          preferredUsername,
          displayName,
          email,
          emailVerified,
          roles,
        },
        'afterCallback: derived user info'
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
        rolesAreAuthoritative,
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

    // Determine cookie security
    const eocCookieSecure = shouldOidcCookieBeSecure(baseURL);
    logger.debug({ eocCookieSecure }, 'OIDC session cookie security');
    logger.debug('Using shared SQLite session store for OIDC');

    // Add custom logout handler if OIDC_LOGOUT_URL is configured
    // This must be added before EOC middleware to intercept /logout requests
    if (oidc.logoutURL) {
      const logoutHandler = createLogoutHandler({
        logoutURL: oidc.logoutURL,
        baseURL,
        cookieSecure: eocCookieSecure,
      });

      if (logoutHandler) {
        app.get('/logout', logoutHandler);
        logger.debug({ logoutURL: oidc.logoutURL }, 'Custom logout handler configured');
      }
    }

    // Configure OIDC middleware
    app.use(
      eocAuth({
        authRequired: false,
        auth0Logout: false,
        idpLogout: false,
        issuerBaseURL: oidc.issuer,
        baseURL,
        clientID: oidc.clientId,
        clientSecret: oidc.clientSecret || undefined,
        secret: sessionSecret,
        authorizationParams: {
          response_type: 'code',
          scope: scopeParam,
        },
        session: {
          store: oidcStore,
          rolling: true,
          // Convert milliseconds to seconds for absoluteDuration
          absoluteDuration: Math.floor(
            ((envAuthConfig && envAuthConfig.sessionMaxAgeMs) || 30 * 24 * 60 * 60 * 1000) / 1000
          ), // Default: 30 days in seconds
          cookie: {
            sameSite: 'Lax',
            secure: eocCookieSecure,
            httpOnly: true,
          },
        },
        afterCallback: createAfterCallbackHandler(oidc, envAuthConfig),
      })
    );

    logger.info('Express OpenID Connect is configured');
    logger.debug('EOC middleware mounted');
  } catch (e) {
    logger.warn({ err: e }, 'Failed to configure Express OpenID Connect');
  }
};

module.exports = { configureOidc };
