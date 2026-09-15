import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Which account a volume belongs to, on the routes that change one.
 *
 * A volume is addressed twice in these URLs: by the account in the path and by
 * its own id. Only the id is needed to find it, so a route that looked it up by
 * id alone would let `/users/alice/volumes/<bob's volume>` rename, re-mode or
 * remove Bob's folder while the screen said it was editing Alice. The routes
 * refuse that pairing as "not found", and these pin it — with the same calls
 * made through the right account as the control, so a 404 cannot come from a
 * wrong id instead.
 *
 * The admin and feature gates in front of all of this are pinned in
 * `user-volumes.test.js`.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const ADMIN = { id: 'admin-1', roles: ['admin'] };

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'user-volumes-owner-', env: { USER_VOLUMES: 'true' } });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
    ).run(id, `${id}@example.com`, id, id, now, now);
  }
  const media = path.join(currentEnv.volumeDir, 'Media');
  await fs.mkdir(media, { recursive: true });

  const routes = currentEnv.requireFresh('src/routes/userVolumes');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = ADMIN;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);

  const created = await request(app)
    .post('/api/users/bob/volumes')
    .send({ label: 'Media', path: media, accessMode: 'readonly' });
  expect(created.status).toBe(201);

  return { app, db, media, bobVolume: created.body.volume };
};

const volumesOf = async (app, userId) =>
  (await request(app).get(`/api/users/${userId}/volumes`)).body.volumes;

describe('a volume reached through an account it does not belong to', () => {
  it('is not changed', async () => {
    const { app, bobVolume } = await seed();

    const response = await request(app)
      .patch(`/api/users/alice/volumes/${bobVolume.id}`)
      .send({ label: 'Taken', accessMode: 'readwrite' });

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Volume not found.');
    expect(await volumesOf(app, 'bob')).toMatchObject([{ label: 'Media', accessMode: 'readonly' }]);
  });

  it('is not removed', async () => {
    const { app, bobVolume } = await seed();

    const response = await request(app).delete(`/api/users/alice/volumes/${bobVolume.id}`);

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Volume not found.');
    expect((await volumesOf(app, 'bob')).map((v) => v.id)).toEqual([bobVolume.id]);
  });
});

describe('a volume reached through the account it belongs to', () => {
  it('is changed, and then removed', async () => {
    const { app, bobVolume } = await seed();

    const patched = await request(app)
      .patch(`/api/users/bob/volumes/${bobVolume.id}`)
      .send({ label: 'Films', accessMode: 'readwrite' });
    expect(patched.status).toBe(200);
    expect(patched.body.volume).toMatchObject({ label: 'Films', accessMode: 'readwrite' });

    const removed = await request(app).delete(`/api/users/bob/volumes/${bobVolume.id}`);
    expect(removed.status).toBe(204);
    expect(await volumesOf(app, 'bob')).toEqual([]);
  });
});

describe('assigning a volume to an account that does not exist', () => {
  it('is refused, and stores nothing', async () => {
    const { app, db, media } = await seed();

    const response = await request(app)
      .post('/api/users/nobody/volumes')
      .send({ label: 'Elsewhere', path: media });

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('User not found.');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM user_volumes WHERE user_id = 'nobody'").get().n
    ).toBe(0);
  });
});
