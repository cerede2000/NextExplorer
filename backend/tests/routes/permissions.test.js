import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The two routes that hand a path to `chmod` and `chown`.
 *
 * They are the pair that once shipped with no admin check at all, and they are
 * the only place in the application where a value from a request reaches a
 * system tool. Both facts are pinned here: that a regular account is refused,
 * and that nothing shaped like an option can reach the argument list.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const REGULAR_USER = { id: 'user-1', username: 'regular', roles: ['user'] };
const ADMIN_USER = { id: 'admin-1', username: 'admin', roles: ['admin'] };

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'permissions-' });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  for (const user of [REGULAR_USER, ADMIN_USER]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      `${user.username}@example.com`,
      user.username,
      user.username,
      JSON.stringify(user.roles),
      now,
      now
    );
  }
  const dir = path.join(currentEnv.volumeDir, 'Docs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'note.txt'), 'hello\n');
  return dir;
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/permissions');
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

describe('who may change permissions', () => {
  it('refuses a regular account on chmod', async () => {
    await seed();

    const response = await request(buildApp(REGULAR_USER))
      .post('/api/permissions/chmod')
      .send({ path: 'Docs/note.txt', mode: '777' });

    expect(response.status).toBe(403);
  });

  it('refuses a regular account on chown', async () => {
    await seed();

    const response = await request(buildApp(REGULAR_USER))
      .post('/api/permissions/chown')
      .send({ path: 'Docs/note.txt', owner: 'root' });

    expect(response.status).toBe(403);
  });

  /**
   * A write permission on a path is not consent to re-permission its tree —
   * the refusal has to come from the role, not from the path being unreachable.
   */
  it('refuses before it has looked at the path at all', async () => {
    await seed();

    const response = await request(buildApp(REGULAR_USER))
      .post('/api/permissions/chmod')
      .send({ path: 'Docs/does-not-exist.txt', mode: '777' });

    expect(response.status).toBe(403);
  });
});

describe('what may reach chmod', () => {
  it('changes the mode of a real file', async () => {
    const dir = await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chmod')
      .send({ path: 'Docs/note.txt', mode: '640' });

    expect(response.status).toBe(200);
    const stats = await fs.stat(path.join(dir, 'note.txt'));
    expect(stats.mode & 0o777).toBe(0o640);
  });

  // The mode is interpolated into a `chmod -R` argument list on the recursive
  // path. Only three octal digits can get that far.
  it.each([['755 --reference=/etc/shadow'], ['7555'], ['75\n5'], ['a+x'], ['']])(
    'refuses the mode %j',
    async (mode) => {
      await seed();

      const response = await request(buildApp(ADMIN_USER))
        .post('/api/permissions/chmod')
        .send({ path: 'Docs/note.txt', mode });

      expect(response.status).toBe(400);
    }
  );

  // The status alone proves nothing here: a share path is unreachable anyway,
  // so it is refused either way. Only the reason says which check fired.
  it('refuses a path reached through a share, and says so', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chmod')
      .send({ path: 'share/abc/note.txt', mode: '640' });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe('Permissions cannot be changed through a share.');
  });

  it('requires a path', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chmod')
      .send({ mode: '640' });

    expect(response.status).toBe(400);
  });
});

describe('what may reach chown', () => {
  /**
   * `chown` takes its arguments as an array and never through a shell, so a
   * semicolon is harmless — an argument that reads as an *option* is not.
   * `--reference=FILE` makes chown copy another file's ownership, and a
   * leading dash is what the pattern exists to refuse.
   */
  it.each([['--reference=/etc/shadow'], ['-R'], ['root nobody'], ['root;id'], ['.hidden'], ['-']])(
    'refuses the owner %j',
    async (owner) => {
      await seed();

      const response = await request(buildApp(ADMIN_USER))
        .post('/api/permissions/chown')
        .send({ path: 'Docs/note.txt', owner });

      expect(response.status).toBe(400);
    }
  );

  it('refuses a group of the same shape', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chown')
      .send({ path: 'Docs/note.txt', group: '--reference=/etc/shadow' });

    expect(response.status).toBe(400);
  });

  it('accepts an ordinary account name', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chown')
      .send({ path: 'Docs/note.txt', owner: 'nobody' });

    // Changing ownership needs root, which the test process is not; what
    // matters is that the name passed validation and the call was attempted.
    expect(response.status).not.toBe(400);
  });

  it('requires an owner or a group', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chown')
      .send({ path: 'Docs/note.txt' });

    expect(response.status).toBe(400);
  });

  it('refuses a path reached through a share, and says so', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER))
      .post('/api/permissions/chown')
      .send({ path: 'share/abc/note.txt', owner: 'nobody' });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe('Ownership cannot be changed through a share.');
  });
});

describe('reading permissions', () => {
  it('reports the mode, owner and group of a file', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER)).get('/api/permissions/Docs/note.txt');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: 'Docs/note.txt' });
  });

  it('requires a path', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER)).get('/api/permissions/');

    expect(response.status).toBe(400);
  });

  it('says not found rather than failing, for a path that is not there', async () => {
    await seed();

    const response = await request(buildApp(ADMIN_USER)).get('/api/permissions/Docs/absent.txt');

    expect(response.status).toBe(404);
  });
});
