import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Where an upload is allowed to land. The transfer itself is covered by the
 * direct and tus suites; what had no test is the check that runs before either
 * of them — a destination the caller may not write to, and a request that
 * carries no file at all.
 *
 * The route reads `if (!allowed || !resolved)`, and no test can tell those two
 * halves apart: `authorizeAndResolve` returns no resolved path whenever it
 * refuses, so the second half never fires on its own. It is a guard against the
 * service changing that contract, not a branch with a case behind it — worth
 * knowing before spending an hour trying to reach it.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'upload-auth-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('user-1','regular@example.com',1,'regular','Regular','["user"]', ?, ?)`
  ).run(now, now);
  await fs.mkdir(path.join(currentEnv.volumeDir, 'Inbox'), { recursive: true });
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/upload');
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

const ADMIN = { id: 'admin-1', email: 'a@example.com', roles: ['admin'] };
const RESTRICTED = { id: 'user-1', roles: [] };

describe('where a folder upload may start', () => {
  it('reserves a destination the caller may write to', async () => {
    await seed();

    const response = await request(buildApp(ADMIN))
      .post('/api/upload/folder-session')
      .send({ uploadTo: 'Inbox', sourceRoot: 'photos' });

    expect(response.status).toBe(201);
    expect(typeof response.body.targetRoot).toBe('string');
  });

  it('refuses a destination the caller has no access to at all', async () => {
    await seed({ USER_VOLUMES: 'true' });

    const response = await request(buildApp(RESTRICTED))
      .post('/api/upload/folder-session')
      .send({ uploadTo: 'Inbox', sourceRoot: 'photos' });

    expect(response.status).toBe(403);
  });

  /**
   * A read-only assignment is the case that separates the two halves of the
   * check: the path resolves perfectly well, and only the permission says no.
   * Without it, a test passes whether `allowed` is consulted or not.
   */
  it('refuses a destination the caller may only read', async () => {
    await seed({ USER_VOLUMES: 'true' });
    const dbService = currentEnv.requireFresh('src/services/db');
    const db = await dbService.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_volumes (id, user_id, label, path, access_mode, created_at, updated_at)
       VALUES ('uv-ro','user-1','Inbox', ?, 'readonly', ?, ?)`
    ).run(path.join(currentEnv.volumeDir, 'Inbox'), now, now);

    const response = await request(buildApp(RESTRICTED))
      .post('/api/upload/folder-session')
      .send({ uploadTo: 'Inbox', sourceRoot: 'photos' });

    expect(response.status).toBe(403);
  });

  it('refuses a destination outside the volume', async () => {
    await seed();

    const response = await request(buildApp(ADMIN))
      .post('/api/upload/folder-session')
      .send({ uploadTo: '../../etc', sourceRoot: 'photos' });

    expect(response.status).not.toBe(201);
  });
});

describe('an upload with nothing in it', () => {
  it('says so rather than answering as though it worked', async () => {
    await seed();

    const response = await request(buildApp(ADMIN))
      .post('/api/upload')
      .query({ uploadTo: 'Inbox' });

    expect(response.status).toBe(400);
  });
});

describe('what is still being written', () => {
  it('answers with the caller’s own list, empty when there is nothing', async () => {
    await seed();

    const response = await request(buildApp(ADMIN)).get('/api/upload/finalizations');

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });
});
