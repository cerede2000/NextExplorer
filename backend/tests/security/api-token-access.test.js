import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { mountedRoutes, INTEGRATIONS_CONFIGURED } from '../helpers/mounted-routes.js';

/**
 * What an API token opens, and the two doors it does not.
 *
 * The rules live in one place — middleware/apiTokenAuth.js and the admin guard
 * — so this exercises them through a server wired the way the application
 * wires it, with real auth and user routes and a few stand-ins for the shapes
 * the rest of the API has: a read that arrives as a POST, a write, and the
 * terminal.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeouts.
 */

const PASSWORD = 'secret123';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/** Somewhere for a request to arrive, so a refusal is visibly a refusal. */
const answered = (req, res) =>
  res.json({ reached: true, user: req.user?.id || null, viaToken: Boolean(req.apiToken) });

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({
    tag: 'api-token-access-',
    env: { AUTH_ENABLED: 'true', AUTH_MODE: 'local', ...env },
  });
  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const userRoutes = currentEnv.requireFresh('src/routes/users');
  const { ensureAdmin } = currentEnv.requireFresh('src/middleware/ensureAdmin');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  currentEnv.requireFresh('src/services/apiTokens').forgetUseThrottles();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', userRoutes);

  // The shapes the rest of the API comes in. Real routes would need a
  // filesystem to say anything; what is being held here is the gate in front
  // of them, so these say only that the gate let the request through.
  app.get('/api/files/list', answered);
  app.post('/api/download', answered);
  app.post('/api/files/delete', answered);
  app.put('/api/files/save', answered);
  app.patch('/api/files/rename', answered);
  app.delete('/api/files/trash', answered);
  app.post('/api/terminal/session', answered);
  app.get('/api/terminal/anything', answered);
  app.get('/api/admin/only', ensureAdmin, answered);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app };
};

const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return browser;
};

const issue = async (browser, body = {}) => {
  const made = await browser
    .post('/api/auth/tokens')
    .send({ password: PASSWORD, name: 'Script', ...body });
  expect(made.status).toBe(201);
  return made.body.secret;
};

const withToken = (app, secret) => ({
  get: (path) => request(app).get(path).set('Authorization', `Bearer ${secret}`),
  post: (path) => request(app).post(path).set('Authorization', `Bearer ${secret}`),
  put: (path) => request(app).put(path).set('Authorization', `Bearer ${secret}`),
  patch: (path) => request(app).patch(path).set('Authorization', `Bearer ${secret}`),
  delete: (path) => request(app).delete(path).set('Authorization', `Bearer ${secret}`),
});

describe('what an API token opens', () => {
  it('reads the API as the account it belongs to', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner);

    const listed = await withToken(app, secret).get('/api/users/shareable');
    expect(listed.status).toBe(200);

    const me = await withToken(app, secret).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner@example.com');

    const reached = await withToken(app, secret).get('/api/files/list');
    expect(reached.body).toMatchObject({ reached: true, viaToken: true });
  });

  it('opens no session of its own', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner);

    const response = await withToken(app, secret).get('/api/files/list');
    expect(response.status).toBe(200);
    // Nothing to steal from the reply, and nothing to reuse without the token.
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses to change anything when it may only read', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'read' });
    const token = withToken(app, secret);

    for (const attempt of [
      token.post('/api/files/delete'),
      token.put('/api/files/save'),
      token.patch('/api/files/rename'),
      token.delete('/api/files/trash'),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AUTH_TOKEN_READ_ONLY');
    }

    // Reading is still reading.
    expect((await token.get('/api/files/list')).status).toBe(200);
  });

  it('lets a read-only token download a selection', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'read' });

    // The one read that arrives as a POST, because a hundred file names do not
    // fit in a URL. Refusing it would be refusing a read.
    const response = await withToken(app, secret).post('/api/download').send({ items: [] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reached: true, viaToken: true });
  });

  it('changes things when it was issued to', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'write' });
    const token = withToken(app, secret);

    expect((await token.post('/api/files/delete')).status).toBe(200);
    expect((await token.put('/api/files/save')).status).toBe(200);
    expect((await token.delete('/api/files/trash')).status).toBe(200);
  });
});

/**
 * The gate names paths as strings, and the stand-ins above take whatever path
 * they are given — which is how the one read that arrives as a POST was
 * allowed at `/api/files/download` for as long as tokens existed, while the
 * download the interface makes is `/api/download`. A read-only token was
 * refused every selection it asked for, and this file said it was not.
 */
describe('the paths the gate names', () => {
  const routesOf = async () => {
    currentEnv = await setupTestEnv({ tag: 'api-token-paths-', env: INTEGRATIONS_CONFIGURED });
    return mountedRoutes(currentEnv.requireFresh);
  };

  it('are paths the application mounts', async () => {
    const routes = await routesOf();
    const { READ_ONLY_POSTS, ALWAYS_OPEN, CLOSED_PREFIXES } = currentEnv.requireFresh(
      'src/middleware/apiTokenAuth'
    );

    for (const readOnlyPost of READ_ONLY_POSTS) {
      expect(routes).toContainEqual(
        expect.objectContaining({ method: 'POST', path: readOnlyPost })
      );
    }
    for (const open of ALWAYS_OPEN) {
      expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: open }));
    }
    for (const prefix of CLOSED_PREFIXES) {
      expect(routes.some((route) => route.path.startsWith(`${prefix}/`))).toBe(true);
    }
  });
});

describe('the doors an API token never opens', () => {
  it('cannot reach the account, whatever it may do', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'write' });
    const token = withToken(app, secret);

    const closed = [
      token.get('/api/auth/tokens'),
      token.post('/api/auth/tokens').send({ password: PASSWORD, name: 'another' }),
      token.delete('/api/auth/tokens/anything'),
      token
        .post('/api/auth/password')
        .send({ currentPassword: PASSWORD, newPassword: 'x'.repeat(12) }),
      token.get('/api/auth/passkeys'),
      token.post('/api/auth/logout'),
      token.get('/api/auth/status'),
    ];

    for (const attempt of closed) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AUTH_TOKEN_NOT_ALLOWED');
    }

    // Asking who it is stays open: a script may know itself without being able
    // to change itself.
    expect((await token.get('/api/auth/me')).status).toBe(200);
  });

  it('cannot administer the server, even for an administrator', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);

    // The owner is an administrator: the session reaches the admin routes.
    expect((await owner.get('/api/admin/only')).status).toBe(200);
    expect((await owner.get('/api/users')).status).toBe(200);

    const secret = await issue(owner, { scope: 'write' });
    const token = withToken(app, secret);

    for (const attempt of [token.get('/api/admin/only'), token.get('/api/users')]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/administration/i);
    }
  });

  it('cannot open a shell', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'write' });
    const token = withToken(app, secret);

    for (const attempt of [
      token.post('/api/terminal/session'),
      token.get('/api/terminal/anything'),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AUTH_TOKEN_NOT_ALLOWED');
    }
  });
});

describe('an API token is never more than its account', () => {
  it('stops the moment the account is gone', { timeout: 30000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);

    const created = await owner.post('/api/users').send({
      email: 'other@example.com',
      username: 'other',
      password: PASSWORD,
      roles: ['user'],
    });
    expect(created.status).toBe(201);
    const otherId = created.body.user.id;

    const other = request.agent(app);
    await other.post('/api/auth/login').send({ email: 'other@example.com', password: PASSWORD });
    const secret = await issue(other);

    expect((await withToken(app, secret).get('/api/files/list')).status).toBe(200);

    expect((await owner.delete(`/api/users/${otherId}`)).status).toBe(204);

    const after = await withToken(app, secret).get('/api/files/list');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('is the narrower of the two when a cookie rides along', { timeout: 20000 }, async () => {
    const { app } = await build();
    const owner = await setUpOwner(app);
    const secret = await issue(owner, { scope: 'read' });

    // The signed-in browser may write and may administer. The same browser
    // presenting a read-only token may do neither: a request that carries a
    // token is that token's request.
    expect((await owner.post('/api/files/delete')).status).toBe(200);

    const cookie = owner.jar.getCookies('http://127.0.0.1').join('; ');
    const both = await request(app)
      .post('/api/files/delete')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${secret}`);
    expect(both.status).toBe(403);
    expect(both.body.error.code).toBe('AUTH_TOKEN_READ_ONLY');

    const admin = await request(app)
      .get('/api/admin/only')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${secret}`);
    expect(admin.status).toBe(403);
  });
});
