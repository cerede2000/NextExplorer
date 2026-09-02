import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Every gate in the middleware that decides whether a request is let through.
 *
 * Forty-six paths through one function, exercised only sideways by route
 * suites that were testing something else. What it lets past without a session
 * is the list worth being able to read: the health of the process, a feature
 * flag, a branding logo on the login page, two integration callbacks that
 * guard themselves with their own tokens, and a share link.
 *
 * Everything else is a 401, and that is the assertion this file exists for.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/**
 * The middleware and a way to ask it about one request.
 *
 * `next()` with no argument is "let through"; a 401 written to the response is
 * "refused"; `next(error)` is a refusal the error handler will dress up.
 */
const gate = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'auth-gates-', env });
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');

  return async (request = {}) => {
    const req = {
      path: '/api/browse',
      method: 'GET',
      headers: {},
      cookies: {},
      ...request,
    };

    let status = null;
    let body = null;
    const res = {
      status: (code) => {
        status = code;
        return res;
      },
      json: (payload) => {
        body = payload;
        return res;
      },
    };

    let passed = false;
    let failure = null;
    await authMiddleware(req, res, (error) => {
      if (error) failure = error;
      else passed = true;
    });

    return { passed, status, body, failure, req };
  };
};

describe('what goes through without any session at all', () => {
  it('lets anything outside the API alone', async () => {
    const ask = await gate();

    expect((await ask({ path: '/healthz' })).passed).toBe(true);
    expect((await ask({ path: '/index.html' })).passed).toBe(true);
    expect((await ask({ path: '/' })).passed).toBe(true);
  });

  it('lets a preflight through, since it carries no credentials to check', async () => {
    const ask = await gate();

    expect((await ask({ path: '/api/browse', method: 'OPTIONS' })).passed).toBe(true);
  });

  it('lets the feature flags and the branding through', async () => {
    const ask = await gate();

    expect((await ask({ path: '/api/features' })).passed).toBe(true);
    expect((await ask({ path: '/api/features/anything' })).passed).toBe(true);
    // The login page draws itself before anyone has signed in.
    expect((await ask({ path: '/api/branding' })).passed).toBe(true);
  });

  it('lets the sign-in routes through', async () => {
    const ask = await gate();

    expect((await ask({ path: '/api/auth/status' })).passed).toBe(true);
    expect((await ask({ path: '/api/auth/login', method: 'POST' })).passed).toBe(true);
  });

  /**
   * A share link is opened by someone with no account, which is the whole
   * point of it. Browsing inside one is not on this list: that needs either an
   * account or a guest session proving the password was typed.
   */
  it('lets a share link through, but not browsing inside it', async () => {
    const ask = await gate();

    expect((await ask({ path: '/api/share/abc123/access' })).passed).toBe(true);
    expect((await ask({ path: '/api/share/abc123/browse/Docs' })).passed).toBe(false);
  });

  it('refuses everything else', async () => {
    const ask = await gate();

    for (const path of ['/api/browse', '/api/users', '/api/settings', '/api/shares']) {
      const answer = await ask({ path });
      expect(answer.passed, path).toBe(false);
      expect(answer.status, path).toBe(401);
    }
  });
});

describe('the integrations that guard themselves', () => {
  /**
   * An editor's server calls back with its own signed token, which the route
   * checks. Those two paths are open only while the integration is configured
   * — otherwise they are two unauthenticated endpoints for no reason.
   */
  it('opens the ONLYOFFICE callbacks only once a server is configured', async () => {
    const closed = await gate();
    expect((await closed({ path: '/api/onlyoffice/callback' })).passed).toBe(false);
    expect((await closed({ path: '/api/onlyoffice/file' })).passed).toBe(false);

    const open = await gate({ ONLYOFFICE_URL: 'https://office.example.com' });
    expect((await open({ path: '/api/onlyoffice/callback' })).passed).toBe(true);
    expect((await open({ path: '/api/onlyoffice/file' })).passed).toBe(true);
    // Not the whole integration: only the two paths that carry a token.
    expect((await open({ path: '/api/onlyoffice/users' })).passed).toBe(false);
  });

  it('opens the Collabora endpoints only once its URL and secret are both set', async () => {
    const noSecret = await gate({ COLLABORA_URL: 'https://collabora.example.com' });
    expect((await noSecret({ path: '/api/collabora/wopi/files/x' })).passed).toBe(false);

    const configured = await gate({
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET: 'a-secret',
    });
    expect((await configured({ path: '/api/collabora/wopi/files/x' })).passed).toBe(true);
    expect((await configured({ path: '/api/collabora/anything-else' })).passed).toBe(false);
  });
});

describe('when authentication is switched off', () => {
  /**
   * A deployment behind its own front door runs with no accounts at all. Every
   * request then arrives as the same synthetic administrator, because the rest
   * of the application asks who is calling and has to be told something.
   */
  it('lets everything through as one anonymous administrator', async () => {
    const ask = await gate({ AUTH_ENABLED: 'false' });

    const answer = await ask({ path: '/api/users' });

    expect(answer.passed).toBe(true);
    expect(answer.req.user).toMatchObject({ id: 'anonymous', roles: ['admin'] });
  });
});

describe('a guest session', () => {
  it('is ignored when it names a session that does not exist', async () => {
    const ask = await gate();

    const answer = await ask({
      path: '/api/browse',
      headers: { 'x-guest-session': 'not-a-real-session' },
    });

    expect(answer.passed).toBe(false);
    expect(answer.status).toBe(401);
    expect(answer.req.guestSession).toBeUndefined();
  });

  it('is looked for in the cookie as well as the header', async () => {
    const ask = await gate();

    // Both are refused because the session is not real; what is asserted is
    // that neither route into the middleware crashes it.
    expect((await ask({ cookies: { guestSession: 'nope' } })).status).toBe(401);
    expect((await ask({ headers: { 'x-guest-session': 'nope' } })).status).toBe(401);
  });
});
