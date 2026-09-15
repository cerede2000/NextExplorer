import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv, clearModuleCache, modulePath } from '../helpers/env-test-utils.js';

const require = createRequire(import.meta.url);

/**
 * What a password change does to the sessions already open.
 *
 * Changing a password is what someone does when they think it leaked. A
 * session opened with the old one used to stay signed in for as long as it
 * lasted, so whoever had the password kept everything it had opened.
 *
 * The app here is wired the way `createApp` wires it — the SQLite session store
 * behind express-session, then the auth middleware — because the defect lived
 * in what that store kept. A memory store per test, as the other auth tests
 * use, would have nothing to do with the sessions the change has to end.
 *
 * A session is "signed in" when it can reach a route that needs an account;
 * `/api/users/shareable` is the plainest one.
 *
 * Every test hashes passwords with bcryptjs at cost 12, hence the timeout.
 */

const PASSWORD = 'secret123';
const NEW_PASSWORD = 'another456';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'password-change-sessions-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local', ...env },
  });
  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const userRoutes = currentEnv.requireFresh('src/routes/users');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const users = require(modulePath('src/services/users'));

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', userRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, users };
};

/** The session cookie a response set, as a browser would send it back. */
const sessionCookie = (response) => {
  const cookie = (response.headers['set-cookie'] || []).find((c) => c.startsWith('connect.sid='));
  expect(cookie).toBeDefined();
  return cookie.split(';')[0];
};

/** A browser signed in as the first administrator, through the setup. */
const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return { browser, owner: response.body.user, cookie: sessionCookie(response) };
};

/** Another browser, signed in to an existing account. */
const signIn = async (app, identifier, password = PASSWORD) => {
  const browser = request.agent(app);
  const response = await browser.post('/api/auth/login').send({ identifier, password });
  expect(response.status).toBe(200);
  return browser;
};

const statusOf = async (browser) => (await browser.get('/api/users/shareable')).status;

/** The same request, sent with a copy of a cookie rather than from its browser. */
const statusWithCookie = async (app, cookie) =>
  (await request(app).get('/api/users/shareable').set('Cookie', cookie)).status;

const createRegular = (users) =>
  users.createLocalUser({
    email: 'regular@example.com',
    username: 'regular',
    displayName: 'Regular',
    password: PASSWORD,
    roles: ['user'],
  });

describe('changing your own password', { timeout: 30_000 }, () => {
  it('signs out every other session of the account, and keeps the one that changed it', async () => {
    const { app, users } = await build();
    const { browser: here, cookie: copied } = await setUpOwner(app);
    const elsewhere = await signIn(app, 'owner');
    await createRegular(users);
    const somebodyElse = await signIn(app, 'regular');
    expect(await statusOf(elsewhere)).toBe(200);
    expect(await statusWithCookie(app, copied)).toBe(200);

    const response = await here
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    expect(await statusOf(elsewhere)).toBe(401);
    expect(await statusOf(here)).toBe(200);
    expect(await statusOf(somebodyElse)).toBe(200);
  });

  /**
   * The session that made the change moves to a new id. A copy of its cookie,
   * taken along with the password, would otherwise be the one session the
   * change left open.
   */
  it('moves the session that changed it to a new id, so a copy of its cookie ends too', async () => {
    const { app } = await build();
    const { browser: here, cookie: copied } = await setUpOwner(app);

    const response = await here
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    expect(sessionCookie(response)).not.toBe(copied);
    expect(await statusWithCookie(app, copied)).toBe(401);
    expect(await statusOf(here)).toBe(200);
  });

  it('ends nothing when the change is refused', async () => {
    const { app } = await build();
    const { browser: here, cookie: copied } = await setUpOwner(app);
    const elsewhere = await signIn(app, 'owner');

    const response = await here
      .post('/api/auth/password')
      .send({ currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expect(await statusOf(elsewhere)).toBe(200);
    expect(await statusWithCookie(app, copied)).toBe(200);
  });
});

describe("an administrator resetting somebody's password", { timeout: 30_000 }, () => {
  it('signs that account out everywhere, and not the administrator', async () => {
    const { app, users } = await build();
    const { browser: admin } = await setUpOwner(app);
    const regular = await createRegular(users);
    const laptop = await signIn(app, 'regular');
    const phone = await signIn(app, 'regular');

    const response = await admin
      .post(`/api/users/${regular.id}/password`)
      .send({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    expect(await statusOf(laptop)).toBe(401);
    expect(await statusOf(phone)).toBe(401);
    expect(await statusOf(admin)).toBe(200);
  });

  it('keeps the session an administrator resets their own password from, on a new id', async () => {
    const { app } = await build();
    const { browser: here, owner, cookie: copied } = await setUpOwner(app);
    const elsewhere = await signIn(app, 'owner');

    const response = await here
      .post(`/api/users/${owner.id}/password`)
      .send({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    expect(await statusOf(elsewhere)).toBe(401);
    expect(await statusWithCookie(app, copied)).toBe(401);
    expect(await statusOf(here)).toBe(200);
  });
});

/**
 * AUTH_ADMIN_PASSWORD is set again on every start. The same value is not a
 * change, and signing the administrator out at each restart would be a defect
 * of its own; a new value is one.
 */
describe('the administrator password from the environment', { timeout: 30_000 }, () => {
  const restart = async (password) => {
    process.env.AUTH_ADMIN_PASSWORD = password;
    clearModuleCache('src/config/env');
    clearModuleCache('src/config/index');
    clearModuleCache('src/utils/bootstrap');
    await require(modulePath('src/utils/bootstrap')).bootstrap();
  };

  it('signs nobody out when a restart sets the same one, and everyone when it sets another', async () => {
    const { app } = await build({
      AUTH_ADMIN_EMAIL: 'admin@example.com',
      AUTH_ADMIN_PASSWORD: PASSWORD,
    });
    await restart(PASSWORD);
    const admin = await signIn(app, 'admin@example.com');

    await restart(PASSWORD);
    expect(await statusOf(admin)).toBe(200);

    await restart(NEW_PASSWORD);
    expect(await statusOf(admin)).toBe(401);
    await signIn(app, 'admin@example.com', NEW_PASSWORD);
  });
});
