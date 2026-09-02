import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Assigning volumes to accounts. Every endpoint sits behind two gates — an
 * administrator, and the feature actually being switched on — and the order
 * matters: a regular account must be told no before it learns whether the
 * feature exists.
 *
 * `/admin/browse-directories` reads the container's filesystem outside the
 * volume root on purpose, because a volume may point anywhere the container can
 * see. That is exactly why both gates are pinned here.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = { USER_VOLUMES: 'true' }) => {
  currentEnv = await setupTestEnv({ tag: 'user-volumes-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('user-1','regular@example.com',1,'regular','Regular','["user"]', ?, ?)`
  ).run(now, now);
  await fs.mkdir(path.join(currentEnv.volumeDir, 'Media'), { recursive: true });
  return db;
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/userVolumes');
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

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const REGULAR = { id: 'user-1', roles: ['user'] };

const ENDPOINTS = [
  ['get', '/api/users/user-1/volumes', undefined],
  ['post', '/api/users/user-1/volumes', { label: 'Media', path: '/tmp' }],
  ['patch', '/api/users/user-1/volumes/anything', { accessMode: 'readonly' }],
  ['delete', '/api/users/user-1/volumes/anything', undefined],
  ['get', '/api/admin/browse-directories', undefined],
];

const call = (app, method, url, body) => {
  const pending = request(app)[method](url);
  return body ? pending.send(body) : pending;
};

describe('the two gates on assigning volumes', () => {
  it.each(ENDPOINTS)('refuses a regular account on %s %s', async (method, url, body) => {
    await seed();

    const response = await call(buildApp(REGULAR), method, url, body);

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe('Admin access required.');
  });

  it.each(ENDPOINTS)(
    'refuses even an administrator when the feature is off, on %s %s',
    async (method, url, body) => {
      await seed({ USER_VOLUMES: 'false' });

      const response = await call(buildApp(ADMIN), method, url, body);

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('User volumes feature is not enabled.');
    }
  );

  /**
   * The role is checked first, so someone who is not an administrator cannot
   * learn from the answer whether the feature is configured.
   */
  it('tells a regular account about the role, never about the feature', async () => {
    await seed({ USER_VOLUMES: 'false' });

    const response = await request(buildApp(REGULAR)).get('/api/users/user-1/volumes');

    expect(response.body.error.message).toBe('Admin access required.');
  });
});

describe('assigning a volume', () => {
  it('says not found for an account that does not exist', async () => {
    await seed();

    const response = await request(buildApp(ADMIN)).get('/api/users/nobody/volumes');

    expect(response.status).toBe(404);
  });

  it('lists nothing for an account with no assignment', async () => {
    await seed();

    const response = await request(buildApp(ADMIN)).get('/api/users/user-1/volumes');

    expect(response.status).toBe(200);
    expect(response.body.volumes).toEqual([]);
  });

  it('gives back what it assigned', async () => {
    await seed();
    const target = path.join(currentEnv.volumeDir, 'Media');

    const created = await request(buildApp(ADMIN))
      .post('/api/users/user-1/volumes')
      .send({ label: 'Media', path: target, accessMode: 'readonly' });

    expect([200, 201]).toContain(created.status);

    const listed = await request(buildApp(ADMIN)).get('/api/users/user-1/volumes');
    expect(listed.body.volumes.map((v) => v.label)).toEqual(['Media']);
  });
});

describe('browsing for a folder to assign', () => {
  it('lists only the directories it finds', async () => {
    await seed();
    await fs.mkdir(path.join(currentEnv.volumeDir, 'Media', 'inner'), { recursive: true });
    await fs.writeFile(path.join(currentEnv.volumeDir, 'Media', 'file.txt'), 'x');

    const response = await request(buildApp(ADMIN))
      .get('/api/admin/browse-directories')
      .query({ path: path.join(currentEnv.volumeDir, 'Media') });

    expect(response.status).toBe(200);
    expect(response.body.directories.map((d) => d.name)).toEqual(['inner']);
  });

  it('says not found for a path that is not there', async () => {
    await seed();

    const response = await request(buildApp(ADMIN))
      .get('/api/admin/browse-directories')
      .query({ path: '/definitely/not/here' });

    expect(response.status).toBe(404);
  });

  it('refuses a file', async () => {
    await seed();
    const file = path.join(currentEnv.volumeDir, 'Media', 'file.txt');
    await fs.writeFile(file, 'x');

    const response = await request(buildApp(ADMIN))
      .get('/api/admin/browse-directories')
      .query({ path: file });

    expect(response.status).toBe(400);
  });
});
