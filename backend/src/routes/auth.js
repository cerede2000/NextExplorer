const express = require('express');
const { auth, public: publicConfig } = require('../config/index');
const {
  uniqueOrigins,
  sanitizeReturnTo,
  getConfiguredRequestOrigin,
  callbackUrlForOrigin,
  sanitizeOidcPrompt,
  markProviderSignIn,
} = require('../utils/oidcRedirect');
const { getOidcAvailability, oidcIsConfigured } = require('../utils/oidcAvailability');
const logger = require('../utils/logger');

const {
  countUsers,
  createLocalUser,
  attemptLocalLogin,
  changeLocalPassword,
  addLocalPassword,
  getUserAuthMethods,
  getRequestUser,
} = require('../services/users');
const { issueCode, redeemCode, isValidChallenge } = require('../services/oidcMobileBridge');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const {
  ValidationError,
  UnauthorizedError,
  RateLimitError,
  NotFoundError,
  ForbiddenError,
  ServiceUnavailableError,
} = require('../errors/AppError');
const { ErrorCodes } = require('../errors/errorCodes');
const { startAuthenticatedSession } = require('../utils/authenticatedSession');

const rateLimitHandler = (req, res, next, options) => {
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
  const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
  const message = `Too many login attempts. Please wait ${retryAfterMinutes} minute${retryAfterMinutes > 1 ? 's' : ''} before trying again.`;
  next(new RateLimitError(message, retryAfterSeconds, ErrorCodes.RATE_LIMIT_LOGIN));
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const router = express.Router();

/**
 * Whether accounts may be created and signed in with a password here.
 *
 * `/status` already told the interface a password sign-in was not on offer when
 * AUTH_MODE is `oidc`, but the routes behind it answered anyway: on an
 * installation nobody had signed in to yet, anyone who could reach the API
 * could run the setup and become its administrator with a password.
 */
const passwordSignInEnabled = () => ['local', 'both'].includes(auth.mode || 'both');

const refuseWithoutPasswordSignIn = () => {
  if (!passwordSignInEnabled()) {
    throw new ForbiddenError('Password sign-in is not enabled on this server.');
  }
};

/**
 * Run setups one at a time. Between counting the accounts and creating the
 * first one there is a password hash, long enough for two setups sent together
 * to both find none and both make an administrator.
 */
let setupQueue = Promise.resolve();
const oneSetupAtATime = (task) => {
  const run = setupQueue.then(task, task);
  setupQueue = run.catch(() => {});
  return run;
};

const respondWithUser = async (req, res) => {
  const user = await getRequestUser(req);
  res.json({ user });
};

router.get('/status', async (req, res) => {
  const oidcEnv = (auth && auth.oidc) || {};
  const authMode = auth.mode || 'both';
  // Skip setup requirement if AUTH_MODE is 'oidc' only
  const requiresSetup = auth.enabled && authMode !== 'oidc' ? (await countUsers()) === 0 : false;
  const isEoc = Boolean(
    req.oidc && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()
  );
  const hasLocal = Boolean(req.session && req.session.localUserId);
  const user = await getRequestUser(req);

  // Determine available strategies based on auth.mode
  const strategies = {
    local: authMode === 'local' || authMode === 'both',
    oidc: (authMode === 'oidc' || authMode === 'both') && Boolean(oidcEnv.enabled),
  };

  res.json({
    requiresSetup,
    strategies,
    authEnabled: auth.enabled,
    authMode,
    authenticated: auth.enabled ? Boolean(isEoc || hasLocal) : true,
    user: user || null,
    oidc: {
      enabled: Boolean(oidcEnv.enabled),
      issuer: oidcEnv.issuer || null,
      scopes: oidcEnv.scopes || [],
    },
  });
});

// Initial admin setup
router.post(
  '/setup',
  setupLimiter,
  asyncHandler(async (req, res) => {
    refuseWithoutPasswordSignIn();
    const { email, password, username } = req.body || {};
    const user = await oneSetupAtATime(async () => {
      if ((await countUsers()) > 0) {
        throw new ValidationError('Application already configured. Skipping setup.');
      }
      return createLocalUser({
        email,
        password,
        username: username || email?.split('@')[0],
        displayName: username || email?.split('@')[0],
        roles: ['admin'],
      });
    });
    await startAuthenticatedSession(req, user.id);

    // Clear guest session cookie when user sets up account
    // Clear both scopes: the cookie used to be set on /api, and browsers
    // still holding that one would otherwise keep it.
    res.clearCookie('guestSession', { path: '/' });
    res.clearCookie('guestSession', { path: '/api' });

    res.status(201).json({ user });
  })
);

// Local login with an email address or a username, and a password
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    refuseWithoutPasswordSignIn();
    const { identifier, email, password, username } = req.body || {};
    // `email` and `username` are the older field names; both carried whatever
    // was typed into the one box on the sign-in screen.
    const typed = identifier || email || username;

    let user = null;
    try {
      user = await attemptLocalLogin({ identifier: typed, password });
    } catch (e) {
      if (e?.status === 423) {
        // Seconds in `retryAfter`, which is what the interface reads, with the
        // deadline itself beside it, under a code of its own so the message
        // translates. The ISO date used to sit in `retryAfter` under a generic
        // code, and the sign-in screen could say neither how long nor in what
        // language.
        const lockedUntil = e.until || null;
        const msLeft = lockedUntil ? Date.parse(lockedUntil) - Date.now() : NaN;
        const retryAfter = Number.isFinite(msLeft) ? Math.max(1, Math.ceil(msLeft / 1000)) : null;
        const locked = new RateLimitError(e.message, retryAfter, ErrorCodes.AUTH_ACCOUNT_LOCKED);
        if (lockedUntil) locked.details = { ...locked.details, lockedUntil };
        throw locked;
      }
      throw e;
    }
    if (!user) {
      throw new UnauthorizedError('Invalid credentials.', ErrorCodes.AUTH_INVALID_CREDENTIALS);
    }
    await startAuthenticatedSession(req, user.id);

    // Clear guest session cookie when user logs in
    // Clear both scopes: the cookie used to be set on /api, and browsers
    // still holding that one would otherwise keep it.
    res.clearCookie('guestSession', { path: '/' });
    res.clearCookie('guestSession', { path: '/api' });

    res.json({ user });
  })
);

// Change password (for users with password auth)
router.post(
  '/password',
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const me = await getRequestUser(req);
    if (!me) {
      throw new UnauthorizedError('Authentication required.');
    }

    const { currentPassword, newPassword } = req.body || {};
    // Every other session of the account ends; this one stays signed in, but
    // only if it is signed in here as this account. A session the identity
    // provider opened is not one a password could have opened.
    const signedInHere = Boolean(req.session) && req.session.localUserId === me.id;
    await changeLocalPassword({
      userId: me.id,
      currentPassword,
      newPassword,
      keepSessionId: signedInHere ? req.sessionID : null,
    });
    if (signedInHere) await startAuthenticatedSession(req, me.id);
    res.status(204).end();
  })
);

// Add password authentication to current user (for OIDC-only users)
router.post(
  '/password/add',
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const user = await getRequestUser(req);
    if (!user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const { password } = req.body || {};
    await addLocalPassword({ userId: user.id, password });

    res.json({ message: 'Password authentication added successfully.' });
  })
);

// Get available auth methods for current user
router.get(
  '/methods',
  asyncHandler(async (req, res) => {
    const user = await getRequestUser(req);
    if (!user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const methods = await getUserAuthMethods(user.id);

    res.json({
      methods: methods.map((m) => ({
        id: m.id,
        type: m.method_type,
        provider: m.provider_name || (m.method_type === 'local_password' ? 'Password' : 'Unknown'),
        lastUsedAt: m.last_used_at,
        createdAt: m.created_at,
      })),
    });
  })
);

router.post('/logout', (req, res) => {
  // Clear local app session if present (local auth)
  if (req.session) {
    try {
      req.session.destroy(() => {});
    } catch (_) {
      /* ignore */
    }
  }
  // Clear the EOC session cookie selected for this browser origin. The
  // legacy name is also cleared during the origin-scoped cookie migration.
  const cookieNames = new Set([req.nextExplorerOidcSessionCookieName, 'appSession']);
  for (const cookieName of cookieNames) {
    if (!cookieName) continue;
    try {
      if (cookieName in req) req[cookieName] = undefined;
      const cookieOptions = { path: '/', sameSite: 'Lax', httpOnly: true };
      res.clearCookie(cookieName, { ...cookieOptions, secure: true });
      res.clearCookie(cookieName, { ...cookieOptions, secure: false });
    } catch (_) {
      /* ignore */
    }
  }
  // For IdP/federated logout, the UI navigates to GET /logout separately.
  res.status(204).end();
});

router.get('/me', async (req, res) => {
  await respondWithUser(req, res);
});

router.post('/token', (req, res) => res.status(400).json({ error: 'Token minting is disabled.' }));

/**
 * The provider was asked to take the sign-in, and did not.
 *
 * The real reason goes to the log and never into the response: it is the
 * network's own words, and they name the provider's internal host.
 */
const providerDidNotAnswer = (reason) => {
  logger.error(
    { issuer: auth?.oidc?.issuer, reason },
    'Could not start a sign-in at the identity provider'
  );
  return new ServiceUnavailableError(
    'The identity provider could not be reached.',
    ErrorCodes.AUTH_OIDC_PROVIDER_UNAVAILABLE
  );
};

/**
 * Nothing here can hand a sign-in over. Which of the two it is decides what an
 * administrator should go and do.
 *
 * Answering 404 "OIDC is not configured" for both is the defect: it sends
 * somebody whose provider is simply down to change a configuration that is
 * already right. The configuration pass records which it was.
 */
const noProviderSignInAvailable = () => {
  const { reason } = getOidcAvailability();

  // Configured, and it could not be mounted: a bad issuer URL, a client secret
  // the library insists on, a provider that did not answer discovery. Which of
  // those it was is in the log; what matters here is that it is not the
  // settings an administrator would be sent to fill in.
  if (oidcIsConfigured()) {
    logger.error(
      { issuer: auth?.oidc?.issuer, reason },
      'Single sign-on is configured and could not be started'
    );
    return new ServiceUnavailableError(
      'Single sign-on could not be started.',
      ErrorCodes.AUTH_OIDC_PROVIDER_UNAVAILABLE
    );
  }

  logger.warn(
    { missing: reason },
    'A sign-in at the identity provider was asked for, and none is configured'
  );
  return new NotFoundError('OIDC is not configured.', ErrorCodes.AUTH_OIDC_NOT_CONFIGURED);
};

router.get(
  '/oidc/login',
  asyncHandler(async (req, res) => {
    if (!(res.oidc && typeof res.oidc.login === 'function')) {
      throw noProviderSignInAvailable();
    }

    const redirect = sanitizeReturnTo(req.query?.redirect, '/browse/');
    const origins = uniqueOrigins([auth?.oidc?.callbackUrl, ...(publicConfig?.origins || [])]);
    const origin = getConfiguredRequestOrigin(req, origins) || origins[0];
    const prompt = sanitizeOidcPrompt(req.query?.prompt);
    const authorizationParams = {
      ...(origin ? { redirect_uri: callbackUrlForOrigin(origin) } : {}),
      ...(prompt ? { prompt } : {}),
    };

    try {
      // Marked for the OIDC error middleware: the library usually reports a
      // failure to a `next` of its own rather than throwing here.
      markProviderSignIn(req);
      await res.oidc.login({ returnTo: redirect, authorizationParams });
    } catch (e) {
      // It was asked and it failed, so this is never the configuration.
      throw providerDidNotAnswer(e?.message || null);
    }
  })
);

// Allowlisted custom scheme URIs the native apps (iOS/Android) register. The code
// is only ever delivered to one of these, never an arbitrary or http(s) URL.
const mobileRedirectUris = (auth && auth.oidc && auth.oidc.mobileRedirectUris) || [
  'nextexplorer://oidc-callback',
];

const resolveMobileRedirect = (requested) => {
  if (requested === undefined) return mobileRedirectUris[0];
  return mobileRedirectUris.includes(requested) ? requested : null;
};

const buildMobileRedirect = (redirectUri, params) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

// Step 1 of native OIDC: the app opens this in ASWebAuthenticationSession (iOS) or
// Custom Tabs (Android) with a PKCE code_challenge. It stashes the challenge and the
// chosen redirect in the (throwaway) browser session and kicks off standard OIDC login.
router.get(
  '/oidc/mobile/login',
  asyncHandler(async (req, res) => {
    if (!(res.oidc && typeof res.oidc.login === 'function')) {
      throw noProviderSignInAvailable();
    }
    const codeChallenge = req.query?.code_challenge;
    const method = req.query?.code_challenge_method || 'S256';
    if (!isValidChallenge(codeChallenge) || method !== 'S256') {
      throw new ValidationError('A valid PKCE code_challenge (S256) is required.');
    }
    const redirectUri = resolveMobileRedirect(req.query?.redirect_uri);
    if (!redirectUri) {
      throw new ValidationError('Unrecognized redirect_uri.');
    }
    if (req.session) {
      req.session.oidcMobile = { codeChallenge, method, redirectUri };
    }
    try {
      markProviderSignIn(req);
      await res.oidc.login({ returnTo: '/api/auth/oidc/mobile/complete' });
    } catch (e) {
      throw providerDidNotAnswer(e?.message || null);
    }
  })
);

// Step 2: OIDC login has completed inside the web session. Mint a single use code
// bound to the authenticated user and the PKCE challenge, then hand it back to the
// app via the custom scheme. Errors are reported the same way so the app can react.
router.get(
  '/oidc/mobile/complete',
  asyncHandler(async (req, res) => {
    const pending = req.session?.oidcMobile;
    if (req.session) delete req.session.oidcMobile;

    const redirectUri = resolveMobileRedirect(pending?.redirectUri);
    if (!redirectUri) {
      throw new ValidationError('Unrecognized redirect_uri.');
    }

    const isAuthed = Boolean(
      req.oidc && typeof req.oidc.isAuthenticated === 'function' && req.oidc.isAuthenticated()
    );
    if (!isAuthed || !pending || !isValidChallenge(pending.codeChallenge)) {
      return res.redirect(buildMobileRedirect(redirectUri, { error: 'auth_failed' }));
    }

    const user = await getRequestUser(req);
    if (!user || !user.id || String(user.id).startsWith('oidc:')) {
      return res.redirect(buildMobileRedirect(redirectUri, { error: 'no_profile' }));
    }

    const code = issueCode({
      userId: user.id,
      codeChallenge: pending.codeChallenge,
      method: pending.method,
    });
    return res.redirect(buildMobileRedirect(redirectUri, { code }));
  })
);

// Step 3: the app exchanges the one time code plus its PKCE verifier for a normal
// local session cookie, reusing the same session plumbing as password login.
router.post(
  '/oidc/exchange',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { code, code_verifier: codeVerifier } = req.body || {};
    const result = redeemCode({ code, codeVerifier });
    if (!result) {
      throw new UnauthorizedError(
        'Invalid or expired authorization code.',
        ErrorCodes.AUTH_INVALID_CREDENTIALS
      );
    }

    // The same call every other way in makes a session with, and for the same
    // reason: it rotates the session id. Assigning the user onto the session
    // already in hand leaves whoever knew that id before signing in knowing a
    // signed-in one.
    await startAuthenticatedSession(req, result.userId);

    const user = await getRequestUser(req);
    if (!user) {
      if (req.session) delete req.session.localUserId;
      throw new UnauthorizedError('User no longer exists.', ErrorCodes.AUTH_INVALID_CREDENTIALS);
    }

    // Clear both scopes: the cookie used to be set on /api, and browsers still
    // holding that one would otherwise keep it.
    res.clearCookie('guestSession', { path: '/' });
    res.clearCookie('guestSession', { path: '/api' });
    res.json({ user });
  })
);

module.exports = router;
