import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What changing your own password does to the sessions of the account.
 *
 * Every other one ends — that is the point of changing it — and the browser
 * doing the changing stays signed in. `changeLocalPassword` takes the session
 * to keep and says as much in its own documentation, but nothing ever passed
 * one, so the person was signed out of their own browser along with whoever
 * they were locking out, and landed on the sign-in page with no idea whether
 * the change had gone through.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeout.
 */

const PASSWORD = 'secret123';
const NEXT = 'another456';

let env;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const build = async () => {
  env = await setupTestEnv({
    tag: 'password-sessions-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local' },
  });
  const { configureSession } = env.requireFresh('src/middleware/session');
  const authMiddleware = env.requireFresh('src/middleware/authMiddleware');
  const authRoutes = env.requireFresh('src/routes/auth');
  const { errorHandler, notFoundHandler } = env.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

/** A browser signed in as the owner. The first one sets the account up. */
const signIn = async (app, { setup = false } = {}) => {
  const browser = request.agent(app);
  const response = setup
    ? await browser
        .post('/api/auth/setup')
        .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD })
    : await browser.post('/api/auth/login').send({ username: 'owner', password: PASSWORD });
  expect(response.status).toBe(setup ? 201 : 200);
  return browser;
};

describe('changing your own password', { timeout: 30_000 }, () => {
  it('leaves the browser that changed it signed in', async () => {
    const app = await build();
    const browser = await signIn(app, { setup: true });

    const changed = await browser
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEXT });
    expect(changed.status).toBe(204);

    // Not "the cookie is still set" — that it still opens anything.
    const me = await browser.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ username: 'owner' });
  });

  it('ends every other session of the account', async () => {
    const app = await build();
    const first = await signIn(app, { setup: true });
    const elsewhere = await signIn(app);
    expect((await elsewhere.get('/api/auth/me')).body.user).toMatchObject({ username: 'owner' });

    await first.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: NEXT });

    // `/me` is an auth route, so it answers rather than refusing: what it says
    // is that this browser is nobody now. Asserted on the answer and not on a
    // status, which the route never had to give.
    expect((await elsewhere.get('/api/auth/me')).body.user).toBeNull();
  });

  it('is the new password that signs in afterwards', async () => {
    const app = await build();
    const browser = await signIn(app, { setup: true });
    await browser.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: NEXT });

    const stale = request.agent(app);
    expect(
      (await stale.post('/api/auth/login').send({ username: 'owner', password: PASSWORD })).status
    ).toBe(401);
    expect(
      (await stale.post('/api/auth/login').send({ username: 'owner', password: NEXT })).status
    ).toBe(200);
  });
});
