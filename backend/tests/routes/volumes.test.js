import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Which volumes a caller is told about. Four different answers depending on who
 * is asking and whether `USER_VOLUMES` is on — and one of them, the empty list
 * for a share visitor, is the difference between a link to one folder and a map
 * of the whole server.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'volumes-route-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  for (const [id, username, roles] of [
    ['admin-1', 'admin', '["admin"]'],
    ['user-1', 'regular', '["user"]'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, `${username}@example.com`, username, username, roles, now, now);
  }
  await fs.mkdir(path.join(currentEnv.volumeDir, 'Media'), { recursive: true });
  await fs.mkdir(path.join(currentEnv.volumeDir, 'Documents'), { recursive: true });
  return db;
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/volumes');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const REGULAR = { id: 'user-1', roles: ['user'] };

describe('who is told which volumes exist', () => {
  /**
   * A share visitor carries a guest session and no account. Listing volumes for
   * them turns a link to one folder into a map of the server.
   */
  it('tells a visitor with no account nothing', async () => {
    await seed();

    const response = await request(buildApp(null)).get('/api/volumes');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('shows every volume when the feature is off', async () => {
    await seed();

    const response = await request(buildApp(REGULAR)).get('/api/volumes');

    expect(response.status).toBe(200);
    expect(response.body.map((v) => v.name).sort()).toEqual(['Documents', 'Media']);
  });

  it('shows every volume to an administrator even when the feature is on', async () => {
    await seed({ USER_VOLUMES: 'true' });

    const response = await request(buildApp(ADMIN)).get('/api/volumes');

    expect(response.body.map((v) => v.name).sort()).toEqual(['Documents', 'Media']);
  });

  it('shows a regular account only what it was assigned', async () => {
    const db = await seed({ USER_VOLUMES: 'true' });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_volumes (id, user_id, label, path, access_mode, created_at, updated_at)
       VALUES ('uv1','user-1','Media', ?, 'readwrite', ?, ?)`
    ).run(path.join(currentEnv.volumeDir, 'Media'), now, now);

    const response = await request(buildApp(REGULAR)).get('/api/volumes');

    expect(response.status).toBe(200);
    expect(response.body.map((v) => v.name)).toEqual(['Media']);
    expect(response.body[0]).toMatchObject({ kind: 'volume', accessMode: 'readwrite' });
  });

  it('gives a regular account with no assignment an empty list', async () => {
    await seed({ USER_VOLUMES: 'true' });

    const response = await request(buildApp(REGULAR)).get('/api/volumes');

    expect(response.body).toEqual([]);
  });
});
