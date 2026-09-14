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

/**
 * An account locked by failed sign-ins, seen from the administration screen.
 *
 * The lock frees itself after AUTH_LOCK_MINUTES and nothing else could free it:
 * no list showed which accounts were locked, and releasing one meant deleting a
 * row from auth_locks by hand. Asked for upstream in nxzai/NextExplorer#370.
 * Locked here the way a person locks it — five wrong passwords — and checked
 * released the way it matters: the right password signs in again.
 */
describe('an account locked by failed sign-ins', () => {
  const PASSWORD = 'correct horse battery staple';

  const lockOut = async (users, identifier) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await users.attemptLocalLogin({ identifier, password: 'wrong password' });
    }
  };

  const signInStatus = async (users, identifier, password = PASSWORD) => {
    try {
      return (await users.attemptLocalLogin({ identifier, password })) ? 'signed-in' : 'refused';
    } catch (error) {
      return error.status === 423 ? 'locked' : `error ${error.message}`;
    }
  };

  const listed = async (app, id) => {
    const response = await request(app).get('/api/users');
    return response.body.users.find((user) => user.id === id);
  };

  it('shows in the list, with the moment it frees itself', async () => {
    const { users, admin, regular } = await seed();
    await lockOut(users, 'regular');

    const app = asAdmin(admin);
    const locked = await listed(app, regular.id);
    const other = await listed(app, admin.id);

    expect(Date.parse(locked.lockedUntil)).toBeGreaterThan(Date.now());
    expect(other.lockedUntil).toBeNull();
  }, 30_000);

  it('is no longer shown once the lock has run out', async () => {
    const { users, admin, regular } = await seed();
    await lockOut(users, 'regular');
    const db = await currentEnv.requireFresh('src/services/db').getDb();
    db.prepare('UPDATE auth_locks SET locked_until = ? WHERE key = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      regular.id
    );

    expect((await listed(asAdmin(admin), regular.id)).lockedUntil).toBeNull();
  }, 30_000);

  it('can be released by an administrator, after which the password signs in', async () => {
    const { users, admin, regular } = await seed();
    await lockOut(users, 'regular');
    // The lock is real before it is released, or the release proves nothing.
    expect(await signInStatus(users, 'regular')).toBe('locked');

    const response = await request(asAdmin(admin)).delete(`/api/users/${regular.id}/lock`);

    expect(response.status).toBe(204);
    expect(await signInStatus(users, 'regular')).toBe('signed-in');
    expect((await listed(asAdmin(admin), regular.id)).lockedUntil).toBeNull();
  }, 30_000);

  /**
   * Releasing clears the count as well as the deadline. Clearing only the
   * deadline would leave five failures on the books, and the very next typo
   * would lock the account again.
   */
  it('starts the count again, so one more typo does not lock it straight back', async () => {
    const { users, admin, regular } = await seed();
    await lockOut(users, 'regular');

    await request(asAdmin(admin)).delete(`/api/users/${regular.id}/lock`);
    await users.attemptLocalLogin({ identifier: 'regular', password: 'one more typo' });

    expect(await signInStatus(users, 'regular')).toBe('signed-in');
  }, 30_000);

  it('cannot be released by someone who is not an administrator', async () => {
    const { users, admin, regular } = await seed();
    await lockOut(users, 'admin');

    const response = await request(asRegular(regular)).delete(`/api/users/${admin.id}/lock`);

    expect(response.status).toBe(403);
    expect(await signInStatus(users, 'admin')).toBe('locked');
  }, 30_000);

  it('answers not found for an account that does not exist', async () => {
    const { admin } = await seed();

    const response = await request(asAdmin(admin)).delete('/api/users/no-such-account/lock');

    expect(response.status).toBe(404);
    // The reason, not only the status: a route that did not exist answered 404
    // too, and this test passed before there was anything to test.
    expect(response.body.error?.message).toMatch(/User not found/);
  });

  it('treats releasing an account that is not locked as done, not as an error', async () => {
    const { admin, regular } = await seed();

    const response = await request(asAdmin(admin)).delete(`/api/users/${regular.id}/lock`);

    expect(response.status).toBe(204);
  });
});
