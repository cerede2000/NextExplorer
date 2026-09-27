import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What an administrator changes on somebody else's account: the password, the
 * email address, and the roles.
 *
 * Resetting a password is how a locked-out person gets back in, so a reset has
 * to take effect — asserted by signing in, since a 204 alone says nothing
 * about what was stored — and has to hold the same length rule as every other
 * way a password is set.
 *
 * The email address is what somebody signs in with and what an identity
 * provider's account is linked to by, so no two accounts may share one and no
 * account may be left without.
 *
 * Who may reach these routes, and the rules that keep the last administrator,
 * are pinned in `users.test.js`.
 */

const PASSWORD = 'correct horse battery staple';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'users-admin-changes-' });
  const users = currentEnv.requireFresh('src/services/users');
  const admin = await users.createLocalUser({
    email: 'admin@example.com',
    username: 'admin',
    displayName: 'Admin',
    password: PASSWORD,
    roles: ['admin'],
  });
  const regular = await users.createLocalUser({
    email: 'regular@example.com',
    username: 'regular',
    displayName: 'Regular',
    password: PASSWORD,
    roles: ['user'],
  });

  const routes = currentEnv.requireFresh('src/routes/users');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: admin.id, username: admin.username, roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);

  return { app, users, admin, regular };
};

const signsIn = async (users, identifier, password) =>
  Boolean(await users.attemptLocalLogin({ identifier, password }));

describe("resetting somebody's password", { timeout: 30_000 }, () => {
  it('replaces it: the old one stops signing in and the new one starts', async () => {
    const { app, users, regular } = await seed();

    const response = await request(app)
      .post(`/api/users/${regular.id}/password`)
      .send({ newPassword: 'another456' });

    expect(response.status).toBe(204);
    expect(await signsIn(users, 'regular', PASSWORD)).toBe(false);
    expect(await signsIn(users, 'regular', 'another456')).toBe(true);
  });

  it('refuses a password under six characters, and the old one keeps working', async () => {
    const { app, users, regular } = await seed();

    const response = await request(app)
      .post(`/api/users/${regular.id}/password`)
      .send({ newPassword: '12345' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Password must be at least 6 characters long.');
    expect(await signsIn(users, 'regular', PASSWORD)).toBe(true);
    expect(await signsIn(users, 'regular', '12345')).toBe(false);
  });
});

describe("changing somebody's email address", () => {
  const emailOf = async (app, id) =>
    (await request(app).get('/api/users')).body.users.find((u) => u.id === id).email;

  /** Written differently, since addresses are compared the way they are stored. */
  it('refuses the address of another account, and keeps the one it had', async () => {
    const { app, regular } = await seed();

    const response = await request(app)
      .patch(`/api/users/${regular.id}`)
      .send({ email: '  ADMIN@example.com ' });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe('Email already in use.');
    expect(await emailOf(app, regular.id)).toBe('regular@example.com');
  });

  it('refuses to leave an account without one', async () => {
    const { app, regular } = await seed();

    const response = await request(app).patch(`/api/users/${regular.id}`).send({ email: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Email is required.');
    expect(await emailOf(app, regular.id)).toBe('regular@example.com');
  });
});

describe("changing somebody's roles", () => {
  /**
   * The admin check everywhere else is an exact `includes('admin')`, so a role
   * stored with its spaces, or a number in the list, would be a promotion that
   * grants nothing — or a list another reader chokes on.
   */
  it('promotes an account to administrator, keeping only real role names', async () => {
    const { app, regular } = await seed();

    const response = await request(app)
      .patch(`/api/users/${regular.id}`)
      .send({ roles: [' admin ', 42, '', 'user'] });

    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['admin', 'user']);
  });
});
