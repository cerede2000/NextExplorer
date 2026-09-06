import { afterEach, describe, expect, it } from 'vitest';
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
