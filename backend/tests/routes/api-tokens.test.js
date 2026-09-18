import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Issuing, naming and revoking an API token, through the routes that do it.
 *
 * The server is wired the way the application wires it — session store, auth
 * middleware, the real routes — because what is pinned here is what somebody
 * signed in can actually do from the settings page, and what they cannot.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeout.
 */

const PASSWORD = 'secret123';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'api-tokens-routes-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local', ...env },
  });
  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const userRoutes = currentEnv.requireFresh('src/routes/users');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  currentEnv.requireFresh('src/services/apiTokens').forgetUseThrottles();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', userRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app };
};

/** The first administrator, signed in through the setup. */
const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return browser;
};

const issue = (browser, body = {}) =>
  browser.post('/api/auth/tokens').send({ password: PASSWORD, name: 'Backup script', ...body });

describe('issuing an API token', () => {
  it('hands the value over once, and never again', { timeout: 20000 }, async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const made = await issue(browser);
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^nxe_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(made.body.token.name).toBe('Backup script');
    expect(made.body.token.scope).toBe('read');

    // Listed afterwards, it is a name and two dates. The value is gone.
    const listed = await browser.get('/api/auth/tokens');
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret.split('_')[2]);
    expect(listed.body.tokens[0]).not.toHaveProperty('secret');
    expect(listed.body.tokens[0]).not.toHaveProperty('secretHash');
  });

  it('asks for the password of the account it is issued from', { timeout: 20000 }, async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const wrong = await browser.post('/api/auth/tokens').send({ password: 'not-it' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('AUTH_PASSWORD_INCORRECT');

    const missing = await browser.post('/api/auth/tokens').send({ name: 'no password' });
    expect(missing.status).toBe(401);

    expect((await browser.get('/api/auth/tokens')).body.tokens).toEqual([]);
  });

  it('refuses everybody who is not signed in', { timeout: 20000 }, async () => {
    const { app } = await build();
    await setUpOwner(app);

    const stranger = request.agent(app);
    expect((await stranger.get('/api/auth/tokens')).status).toBe(401);
    expect((await stranger.post('/api/auth/tokens').send({ password: PASSWORD })).status).toBe(401);
    expect((await stranger.delete('/api/auth/tokens/abc')).status).toBe(401);
  });

  it(
    'takes a scope and a life, and refuses ones it does not know',
    { timeout: 20000 },
    async () => {
      const { app } = await build();
      const browser = await setUpOwner(app);

      const writing = await issue(browser, { scope: 'write', expiresInDays: 90, name: 'Sync' });
      expect(writing.status).toBe(201);
      expect(writing.body.token.scope).toBe('write');
      expect(new Date(writing.body.token.expiresAt).getTime()).toBeGreaterThan(Date.now());

      expect((await issue(browser, { scope: 'admin' })).status).toBe(400);
      expect((await issue(browser, { scope: 'root' })).status).toBe(400);
      expect((await issue(browser, { expiresInDays: -1 })).status).toBe(400);
      expect((await issue(browser, { expiresInDays: 99999 })).status).toBe(400);
    }
  );

  it('renames one, and revokes one', { timeout: 20000 }, async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);
    const made = await issue(browser);
    const id = made.body.token.id;

    const renamed = await browser.patch(`/api/auth/tokens/${id}`).send({ name: 'Nightly backup' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.token.name).toBe('Nightly backup');

    // Revoking needs no password: somebody who has just realised a token
    // leaked must be able to stop it now, not after finding their password.
    expect((await browser.delete(`/api/auth/tokens/${id}`)).status).toBe(204);
    expect((await browser.get('/api/auth/tokens')).body.tokens).toEqual([]);

    // And again is a 404 rather than a second revocation.
    expect((await browser.delete(`/api/auth/tokens/${id}`)).status).toBe(404);
  });

  it('never touches somebody else’s token', { timeout: 30000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const made = await issue(owner);
    const id = made.body.token.id;

    // A second account, made by the administrator and signed in for itself.
    const created = await owner.post('/api/users').send({
      email: 'other@example.com',
      username: 'other',
      password: PASSWORD,
      roles: ['user'],
    });
    expect(created.status).toBe(201);

    const other = request.agent(app);
    expect(
      (await other.post('/api/auth/login').send({ email: 'other@example.com', password: PASSWORD }))
        .status
    ).toBe(200);

    expect((await other.get('/api/auth/tokens')).body.tokens).toEqual([]);
    expect((await other.patch(`/api/auth/tokens/${id}`).send({ name: 'mine' })).status).toBe(404);
    expect((await other.delete(`/api/auth/tokens/${id}`)).status).toBe(404);

    // The owner's is untouched and still theirs.
    const stillThere = await owner.get('/api/auth/tokens');
    expect(stillThere.body.tokens).toHaveLength(1);
    expect(stillThere.body.tokens[0].name).toBe('Backup script');
  });

  it('writes the issue and the revocation into the activity log', { timeout: 20000 }, async () => {
    const { app } = await build();
    const browser = await setUpOwner(app);

    const settings = currentEnv.requireFresh('src/services/settingsService');
    await settings.setSystemSetting('system', 'activity', { enabled: true });

    const made = await issue(browser, { name: 'Logged token' });
    expect(made.status).toBe(201);
    await browser.delete(`/api/auth/tokens/${made.body.token.id}`);

    const activityLog = currentEnv.requireFresh('src/services/activityLog');
    const { events } = await activityLog.readActivity({ action: 'account.token' });
    expect(events).toHaveLength(2);
    expect(events.map((event) => JSON.parse(event.detail).issued)).toEqual([false, true]);
    expect(events[0].target).toBe('Logged token');
    // What was issued is described; the value itself is not in the log.
    expect(JSON.stringify(events)).not.toContain(made.body.secret.split('_')[2]);
  });

  it('issues none at all where there are no accounts', { timeout: 20000 }, async () => {
    const { app } = await build({ AUTH_ENABLED: 'false' });

    const caller = request.agent(app);
    expect((await caller.get('/api/auth/tokens')).status).toBe(403);
    expect((await caller.post('/api/auth/tokens').send({ name: 'x' })).status).toBe(403);
  });
});
