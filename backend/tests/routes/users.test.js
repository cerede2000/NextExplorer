import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Account administration, and the three rules that keep an installation from
 * locking its owner out: an administrator cannot be demoted, cannot delete
 * themselves, and cannot be removed while they are the last one. Each is a
 * single branch, and the route had no test of its own until now.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'users-route-' });
  const users = currentEnv.requireFresh('src/services/users');

  const admin = await users.createLocalUser({
    email: 'admin@example.com',
    username: 'admin',
    displayName: 'Admin',
    password: 'correct horse battery staple',
    roles: ['admin'],
  });
  const regular = await users.createLocalUser({
    email: 'regular@example.com',
    username: 'regular',
    displayName: 'Regular',
    password: 'correct horse battery staple',
    roles: ['user'],
  });

  return { users, admin, regular };
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/users');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const asAdmin = (admin) => buildApp({ id: admin.id, username: admin.username, roles: ['admin'] });
const asRegular = (regular) =>
  buildApp({ id: regular.id, username: regular.username, roles: ['user'] });

describe('who may administer accounts', () => {
  it.each([
    ['get', '/api/users', undefined],
    ['patch', '/api/users/someone', { roles: ['admin'] }],
    ['post', '/api/users', { email: 'new@example.com', password: 'x' }],
    ['post', '/api/users/someone/password', { newPassword: 'x' }],
    ['delete', '/api/users/someone', undefined],
  ])('refuses a regular account on %s %s', async (method, path, body) => {
    const { regular } = await seed();

    const call = request(asRegular(regular))[method](path);
    const response = body ? await call.send(body) : await call;

    expect(response.status).toBe(403);
  });

  it.each([['/api/users/shareable'], ['/api/users/search?q=reg']])(
    'requires a signed-in account on %s',
    async (path) => {
      await seed();

      const response = await request(buildApp(null)).get(path);

      expect(response.status).toBe(401);
    }
  );
});

describe('the rules that keep an owner from locking themselves out', () => {
  it('refuses to take the admin role away', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin))
      .patch(`/api/users/${admin.id}`)
      .send({ roles: ['user'] });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Demotion of admin is not allowed.');
  });

  it('refuses to delete the account making the request', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin)).delete(`/api/users/${admin.id}`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('You cannot delete your own account.');
  });

  /**
   * The caller carries the admin role without being the local admin account —
   * which is what an administrator elevated by their identity provider looks
   * like. It is the only way to reach this rule: any caller who *is* the last
   * local admin is stopped by the self-deletion rule first, so a test written
   * that way passes whether this rule exists or not.
   */
  it('refuses to remove the last local administrator', async () => {
    const { admin } = await seed();
    const fromTheIdentityProvider = buildApp({
      id: 'oidc|someone-else',
      username: 'federated',
      roles: ['admin'],
    });

    const response = await request(fromTheIdentityProvider).delete(`/api/users/${admin.id}`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Cannot remove the last admin.');
  });

  it('allows removing an administrator while another one remains', async () => {
    const { users, admin } = await seed();
    const secondAdmin = await users.createLocalUser({
      email: 'second@example.com',
      username: 'second',
      displayName: 'Second',
      password: 'correct horse battery staple',
      roles: ['admin'],
    });

    const response = await request(asAdmin(secondAdmin)).delete(`/api/users/${admin.id}`);

    expect(response.status).toBe(204);
  });

  it('lets a regular account be removed', async () => {
    const { admin, regular } = await seed();

    const response = await request(asAdmin(admin)).delete(`/api/users/${regular.id}`);

    expect(response.status).toBe(204);
  });
});

describe('reading and changing accounts', () => {
  it('lists every account for an administrator', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin)).get('/api/users');

    expect(response.status).toBe(200);
    expect(response.body.users.map((u) => u.username).sort()).toEqual(['admin', 'regular']);
  });

  it('leaves the caller out of the list offered for sharing', async () => {
    const { regular } = await seed();

    const response = await request(asRegular(regular)).get('/api/users/shareable');

    expect(response.status).toBe(200);
    expect(response.body.users.map((u) => u.id)).not.toContain(regular.id);
  });

  it('says not found rather than failing, for an account that is not there', async () => {
    const { admin } = await seed();

    const patched = await request(asAdmin(admin))
      .patch('/api/users/nobody-at-all')
      .send({ roles: ['user'] });
    const deleted = await request(asAdmin(admin)).delete('/api/users/nobody-at-all');

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
  });

  it('creates an account and gives back what it made', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin))
      .post('/api/users')
      .send({ email: 'new@example.com', password: 'correct horse battery staple' });

    expect(response.status).toBe(201);
    // The username falls back to the local part of the address.
    expect(response.body.user).toMatchObject({ email: 'new@example.com', username: 'new' });
  });

  it('never returns a password hash', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin)).get('/api/users');

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
  });
});
