import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A request that is the caller's fault, answered as such.
 *
 * Sending no items to delete raised a plain `Error`, which carries no status.
 * The handler read that as an unexpected failure: 500, `isOperational: false`,
 * and a full stack in the log saying the server had broken. Nothing had — the
 * request was malformed, and a malformed request is a thing the caller can fix
 * and the operator should not be paged about.
 */

let currentEnv;

const setup = async () => {
  const env = await setupTestEnv({
    tag: 'malformed-file-requests-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/files/index',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
      'src/utils/pathUtils',
    ],
  });
  currentEnv = env;

  const fileRoutes = env.requireFresh('src/routes/files/index');
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
  const db = await env.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);

  return createTestApp({
    router: fileRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });
};

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('a delete with nothing to delete', () => {
  it('is a client error, not a server one', async () => {
    const app = await setup();

    const response = await request(app).delete('/api/files').send({ items: [] });

    expect(response.status).toBe(400);
  });

  it('is the same when the field is missing entirely', async () => {
    const app = await setup();

    const response = await request(app).delete('/api/files').send({});

    expect(response.status).toBe(400);
  });

  /** The wrong shape is as much the caller's fault as the empty one. */
  it('is the same when it is not a list', async () => {
    const app = await setup();

    const response = await request(app).delete('/api/files').send({ items: 'everything' });

    expect(response.status).toBe(400);
  });

  it('says what was wrong with it', async () => {
    const app = await setup();

    const response = await request(app).delete('/api/files').send({ items: [] });

    expect(response.body?.error?.message).toMatch(/at least one item/i);
  });
});

describe('asking what a delete would affect, with nothing to affect', () => {
  it('is a client error too', async () => {
    const app = await setup();

    const response = await request(app).post('/api/files/delete-impact').send({ items: [] });

    expect(response.status).toBe(400);
  });
});

describe('a transfer with nothing to transfer', () => {
  it('is a client error', async () => {
    const app = await setup();

    const response = await request(app)
      .post('/api/files/copy')
      .send({ items: [], destination: 'Docs' });

    expect(response.status).toBe(400);
  });

  /**
   * The root is not a destination — there is no volume in it to write to. That
   * is the caller choosing wrongly, not the server failing.
   */
  it('refuses the root as a destination without calling it a server failure', async () => {
    const app = await setup();

    const response = await request(app)
      .post('/api/files/copy')
      .send({ items: [{ path: '', name: 'notes.txt' }], destination: '' });

    expect(response.status).toBe(400);
  });
});

/**
 * A refusal, answered as a refusal.
 *
 * Every access decision in the transfer service raised a plain `Error` too, so
 * being told "you may not" arrived as 500 with `isOperational: false` and a
 * stack in the log — an outage, by the shape of it, for a permission working
 * exactly as designed. It also cost the caller: the uploader retries a 500 and
 * does not retry a 403, so a refusal was retried until it ran out of attempts.
 */
describe('a path the caller may not use', () => {
  const setupWithAcl = async (rules) => {
    const env = await setupTestEnv({
      tag: 'transfer-denials-',
      modules: [
        'src/config/env',
        'src/config/index',
        'src/routes/files/index',
        'src/middleware/errorHandler',
        'src/services/accessManager',
        'src/services/accessControlService',
        'src/services/settingsService',
        'src/utils/pathUtils',
      ],
    });
    currentEnv = env;

    const accessControl = env.requireFresh('src/services/accessControlService');
    await accessControl.setRules(rules);

    const fileRoutes = env.requireFresh('src/routes/files/index');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const db = await env.requireFresh('src/services/db').getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES ('user', 'user@example.com', 1, 'user', 'User', '["user"]', ?, ?)`
    ).run(now, now);

    const app = createTestApp({
      router: fileRoutes,
      mountPath: '/api',
      user: { id: 'user', roles: ['user'] },
      errorHandler,
    });
    return { app, volume: env.volumeDir };
  };

  it('refuses a delete from a read-only folder as forbidden, not as a failure', async () => {
    const { app, volume } = await setupWithAcl([
      { path: '/Locked', permissions: 'ro', recursive: true },
    ]);
    await fs.mkdir(path.join(volume, 'Locked'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Locked', 'note.txt'), 'read only');

    const response = await request(app)
      .delete('/api/files')
      .send({ items: [{ path: 'Locked', name: 'note.txt' }] });

    expect(response.status).toBe(403);
  });

  it('leaves the file where it is', async () => {
    const { app, volume } = await setupWithAcl([
      { path: '/Locked', permissions: 'ro', recursive: true },
    ]);
    await fs.mkdir(path.join(volume, 'Locked'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Locked', 'note.txt'), 'read only');

    await request(app)
      .delete('/api/files')
      .send({ items: [{ path: 'Locked', name: 'note.txt' }] });

    await expect(
      fs.access(path.join(volume, 'Locked', 'note.txt'))
    ).resolves.toBeUndefined();
  });

  it('says why rather than only that it failed', async () => {
    const { app, volume } = await setupWithAcl([
      { path: '/Locked', permissions: 'ro', recursive: true },
    ]);
    await fs.mkdir(path.join(volume, 'Locked'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Locked', 'note.txt'), 'read only');

    const response = await request(app)
      .delete('/api/files')
      .send({ items: [{ path: 'Locked', name: 'note.txt' }] });

    expect(response.body?.error?.message).toBeTruthy();
  });
});

describe('a source that is not there', () => {
  it('is a not-found, not a server failure', async () => {
    const app = await setup();

    const response = await request(app)
      .post('/api/files/copy')
      .send({ items: [{ path: '', name: 'never-existed.txt' }], destination: 'Docs' });

    expect(response.status).toBeLessThan(500);
  });
});
