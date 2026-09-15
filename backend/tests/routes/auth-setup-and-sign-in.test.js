import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { setupTestEnv, modulePath } from '../helpers/env-test-utils.js';

const require = createRequire(import.meta.url);

/**
 * The first account, and every sign-in after it.
 *
 * The setup route makes whoever calls it an administrator, so it is the most
 * valuable request an installation ever answers: it has to answer it once and
 * then never again, and a refused attempt must leave the installation exactly
 * as it found it — still waiting for its owner, with nobody signed in.
 *
 * A sign-in, for its part, has to hand the browser a session it did not have
 * before (anyone who knew the old id would otherwise know a signed-in one), and
 * has to say nothing that tells a guesser which names are accounts. Guessing is
 * bounded per client by a rate limit, which is the only bound for names that
 * belong to nobody: the per-account lock deliberately does not count those.
 *
 * Every test hashes at least one password with bcryptjs at cost 12, which is
 * why they carry the same generous timeout as `auth.test.js`.
 */

const PASSWORD = 'secret123';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async () => {
  currentEnv = await setupTestEnv({ tag: 'auth-setup-sign-in-', env: { AUTH_ENABLED: 'true' } });
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const { notFoundHandler, errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  // The instance the routes already loaded, not a fresh copy of it.
  const users = require(modulePath('src/services/users'));

  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.oidc = { isAuthenticated: () => false };
    next();
  });
  // Writes to the session, which is what makes a browser hold an id before it
  // has signed in — the id a fixation attack would plant.
  app.post('/visit', (req, res) => {
    req.session.visited = true;
    res.status(204).end();
  });
  app.use('/api/auth', authRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, users };
};

/** The session id a response hands back, or null when it sets none. */
const sessionId = (response) => {
  const cookie = []
    .concat(response.headers['set-cookie'] || [])
    .find((entry) => entry.startsWith('connect.sid='));
  return cookie ? cookie.split(';')[0].slice('connect.sid='.length) : null;
};

const setUp = (app, body = {}) =>
  request(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD, ...body });

describe('the first-run setup', { timeout: 30_000 }, () => {
  it('refuses a second setup once an account exists, and neither creates nor signs in anyone', async () => {
    const { app, users } = await build();
    expect((await setUp(app)).status).toBe(201);

    const intruder = request.agent(app);
    const response = await intruder
      .post('/api/auth/setup')
      .send({ email: 'intruder@example.com', username: 'intruder', password: PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/already configured/i);
    expect(await users.countUsers()).toBe(1);
    expect((await intruder.get('/api/auth/me')).body.user).toBeNull();
  });

  it.each([
    ['no email address', { email: undefined }, 'VALIDATION_EMAIL_REQUIRED'],
    ['a password under six characters', { password: '12345' }, 'VALIDATION_PASSWORD_TOO_SHORT'],
  ])(
    'refuses a setup with %s, and leaves the installation waiting for one',
    async (_label, body, code) => {
      const { app, users } = await build();

      const response = await setUp(app, body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(code);
      expect(await users.countUsers()).toBe(0);
      expect((await request(app).get('/api/auth/status')).body.requiresSetup).toBe(true);
    }
  );
});

describe('the session a sign-in starts', { timeout: 30_000 }, () => {
  it('is a new one after setup, not the one the browser arrived with', async () => {
    const { app } = await build();
    const browser = request.agent(app);
    const before = sessionId(await browser.post('/visit'));
    expect(before).toBeTruthy();

    const response = await browser
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });

    expect(response.status).toBe(201);
    expect(sessionId(response)).toBeTruthy();
    expect(sessionId(response)).not.toBe(before);
    expect((await browser.get('/api/auth/me')).body.user?.roles).toContain('admin');
  });

  it('is a new one after a password sign-in, not the one the browser arrived with', async () => {
    const { app } = await build();
    await setUp(app);
    const browser = request.agent(app);
    const before = sessionId(await browser.post('/visit'));
    expect(before).toBeTruthy();

    const response = await browser
      .post('/api/auth/login')
      .send({ identifier: 'owner', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(sessionId(response)).toBeTruthy();
    expect(sessionId(response)).not.toBe(before);
    expect((await browser.get('/api/auth/me')).body.user?.email).toBe('owner@example.com');
  });
});

describe('signing in', { timeout: 30_000 }, () => {
  /** `username` is one of the names the sign-in form's field used to be sent under. */
  it('accepts the older username field', async () => {
    const { app } = await build();
    await setUp(app);

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'owner', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('owner@example.com');
  });

  /**
   * Two different answers would turn the sign-in form into a way of listing
   * the accounts of an installation, one guess at a time.
   */
  it('answers a name that belongs to nobody exactly as it answers a wrong password', async () => {
    const { app } = await build();
    await setUp(app);

    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody', password: PASSWORD });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'owner', password: 'not-the-password' });

    const shape = (response) => ({
      status: response.status,
      code: response.body.error?.code,
      message: response.body.error?.message,
    });
    expect(shape(unknown)).toEqual({
      status: 401,
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials.',
    });
    expect(shape(wrong)).toEqual(shape(unknown));
  });

  /**
   * Names that belong to nobody are never counted against an account, so
   * nothing but this limit stops a client from trying one after another.
   */
  it('stops answering one client after ten attempts, whatever names it tries', async () => {
    const { app } = await build();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        .post('/api/auth/login')
        .send({ identifier: `guess-${attempt}`, password: PASSWORD });
      expect(response.status).toBe(401);
    }

    const response = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'guess-10', password: PASSWORD });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('RATE_LIMIT_LOGIN');
    expect(response.body.error.message).toMatch(/Too many login attempts/);
  });
});
