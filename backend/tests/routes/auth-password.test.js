import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { setupTestEnv, modulePath } from '../helpers/env-test-utils.js';

const require = createRequire(import.meta.url);

/**
 * Changing, adding and listing the ways an account signs in.
 *
 * A signed-in session is not proof of knowing the password: a browser left
 * open, or a session id that leaked, is enough to reach these routes. So the
 * change asks for the current password, and adding one refuses where a
 * password already exists — otherwise "add" would be a change that skips the
 * question. A refused change has to leave the old password working, which is
 * asserted by signing in with it rather than by reading the status code alone.
 *
 * Every test hashes passwords with bcryptjs at cost 12, hence the timeout.
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
  currentEnv = await setupTestEnv({ tag: 'auth-password-', env: { AUTH_ENABLED: 'true' } });
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const errorHandlers = currentEnv.requireFresh('src/middleware/errorHandler');
  const users = require(modulePath('src/services/users'));
  const db = await require(modulePath('src/services/db')).getDb();

  /** An app whose requests arrive as `userId`, the way the auth middleware hands them over. */
  const appFor = (userId = null) => {
    const app = express();
    app.use(express.json());
    app.use(
      session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false })
    );
    app.use((req, _res, next) => {
      req.oidc = { isAuthenticated: () => false };
      if (userId) req.user = { id: userId, roles: ['user'] };
      next();
    });
    app.use('/api/auth', authRoutes);
    app.use(errorHandlers.notFoundHandler);
    app.use(errorHandlers.errorHandler);
    return app;
  };

  return { app: appFor(), appFor, users, db };
};

/** The owner, signed in through the setup route on an agent that keeps the session. */
const signedInOwner = async (app) => {
  const browser = request.agent(app);
  const setup = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(setup.status).toBe(201);
  return { browser, owner: setup.body.user };
};

/** An account that signs in only through its identity provider: no password row. */
const federatedAccount = (db) => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('fed-1', 'federated@example.com', 1, 'federated', 'Federated', '["user"]', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
     VALUES ('fed-oidc', 'fed-1', 'oidc', 'https://idp.example', 'sub-fed', 'OIDC', ?)`
  ).run(now);
  return 'fed-1';
};

const signInStatus = async (app, identifier, password) =>
  (await request(app).post('/api/auth/login').send({ identifier, password })).status;

describe('who may touch a password', () => {
  it.each([
    ['post', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another456' }],
    ['post', '/api/auth/password/add', { password: PASSWORD }],
    ['get', '/api/auth/methods', undefined],
  ])('refuses %s %s to someone who is not signed in', async (method, url, body) => {
    const { app } = await build();

    const pending = request(app)[method](url);
    const response = body ? await pending.send(body) : await pending;

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Authentication required.');
  });
});

describe('changing a password', { timeout: 30_000 }, () => {
  it('asks for the current password, and changes nothing without it', async () => {
    const { app } = await build();
    const { browser } = await signedInOwner(app);

    const response = await browser.post('/api/auth/password').send({ newPassword: 'another456' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Current password is required.');
    expect(await signInStatus(app, 'owner', PASSWORD)).toBe(200);
    expect(await signInStatus(app, 'owner', 'another456')).toBe(401);
  });

  it('refuses a new password under six characters, and keeps the old one', async () => {
    const { app } = await build();
    const { browser } = await signedInOwner(app);

    const response = await browser
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: '12345' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_PASSWORD_TOO_SHORT');
    expect(await signInStatus(app, 'owner', PASSWORD)).toBe(200);
    expect(await signInStatus(app, 'owner', '12345')).toBe(401);
  });

  /** A 204 is only worth something if the password it reports changed actually did. */
  it('replaces the password: the old one stops signing in and the new one starts', async () => {
    const { app } = await build();
    const { browser } = await signedInOwner(app);

    const response = await browser
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'another456' });

    expect(response.status).toBe(204);
    expect(await signInStatus(app, 'owner', PASSWORD)).toBe(401);
    expect(await signInStatus(app, 'owner', 'another456')).toBe(200);
  });

  it('is refused for an account that signs in only through its identity provider', async () => {
    const { appFor, db } = await build();
    const userId = federatedAccount(db);

    const response = await request(appFor(userId))
      .post('/api/auth/password')
      .send({ currentPassword: 'anything', newPassword: 'another456' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe(
      'Password change is only allowed for users with password authentication.'
    );
  });
});

describe('adding a password to an account', { timeout: 30_000 }, () => {
  it('gives an account from the identity provider a password it can then sign in with', async () => {
    const { app, appFor, db } = await build();
    const userId = federatedAccount(db);

    const response = await request(appFor(userId))
      .post('/api/auth/password/add')
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    const signIn = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'federated@example.com', password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.id).toBe(userId);
  });

  it('refuses a password under six characters, and adds none', async () => {
    const { appFor, db } = await build();
    const userId = federatedAccount(db);

    const response = await request(appFor(userId))
      .post('/api/auth/password/add')
      .send({ password: '12345' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_PASSWORD_TOO_SHORT');
    const passwords = db
      .prepare(
        "SELECT COUNT(*) AS n FROM auth_methods WHERE user_id = ? AND method_type = 'local_password'"
      )
      .get(userId).n;
    expect(passwords).toBe(0);
  });

  /**
   * Adding over an existing password would be a change that never asked for
   * the current one — exactly what a borrowed session must not be able to do.
   */
  it('refuses to add one where a password exists, and the existing one keeps working', async () => {
    const { app, appFor } = await build();
    const { owner } = await signedInOwner(app);

    const response = await request(appFor(owner.id))
      .post('/api/auth/password/add')
      .send({ password: 'taken-over' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT_PASSWORD_EXISTS');
    expect(await signInStatus(app, 'owner', 'taken-over')).toBe(401);
    expect(await signInStatus(app, 'owner', PASSWORD)).toBe(200);
  });
});

describe('listing how an account signs in', { timeout: 30_000 }, () => {
  it('names each method without handing out the password hash', async () => {
    const { app, appFor, db } = await build();
    const { owner } = await signedInOwner(app);
    db.prepare(
      `INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
       VALUES ('owner-oidc', ?, 'oidc', 'https://idp.example', 'sub-owner', 'OIDC', ?)`
    ).run(owner.id, new Date().toISOString());

    const response = await request(appFor(owner.id)).get('/api/auth/methods');

    expect(response.status).toBe(200);
    expect(response.body.methods.map((m) => [m.type, m.provider]).sort()).toEqual([
      ['local_password', 'Password'],
      ['oidc', 'OIDC'],
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/password_hash|passwordHash|\$2[aby]\$/);
  });
});
