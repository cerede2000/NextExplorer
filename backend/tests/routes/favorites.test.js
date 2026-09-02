import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import nodeFs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Favorites belong to one account. Every operation takes the caller's id from
 * the session and never from the request, which is the only thing standing
 * between two accounts that both hold an id they did not create.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'favorites-' });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  for (const [id, username] of [
    ['alice', 'alice'],
    ['bob', 'bob'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
    ).run(id, `${username}@example.com`, username, username, now, now);
  }
  // A favorite points at somewhere that exists; the service checks.
  for (const folder of ['Docs/alice', 'Docs/bob', 'Docs/one', 'Docs/two', 'Docs/notes']) {
    await nodeFs.mkdir(path.join(currentEnv.volumeDir, folder), { recursive: true });
  }
};

const buildApp = (user) => {
  const routes = currentEnv.requireFresh('src/routes/favorites');
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

const ALICE = { id: 'alice', roles: ['user'] };
const BOB = { id: 'bob', roles: ['user'] };

const addFor = async (user, path, label) => {
  const response = await request(buildApp(user)).post('/api/favorites').send({ path, label });
  expect(response.status).toBe(200);
  return response.body;
};

describe('who may have favorites at all', () => {
  it.each([
    ['get', '/api/favorites', undefined],
    ['post', '/api/favorites', { path: 'Docs', label: 'Docs' }],
    ['patch', '/api/favorites/reorder', { order: [] }],
    ['patch', '/api/favorites/some-id', { label: 'x' }],
    ['delete', '/api/favorites', { path: 'Docs' }],
  ])('refuses a caller with no account on %s %s', async (method, url, body) => {
    await seed();

    const pending = request(buildApp(null))[method](url);
    const response = body ? await pending.send(body) : await pending;

    expect(response.status).toBe(401);
  });
});

describe('keeping one account’s favorites out of another’s', () => {
  it('shows each account only its own', async () => {
    await seed();
    await addFor(ALICE, 'Docs/alice', 'Alice');
    await addFor(BOB, 'Docs/bob', 'Bob');

    const alice = await request(buildApp(ALICE)).get('/api/favorites');
    const bob = await request(buildApp(BOB)).get('/api/favorites');

    expect(alice.body.map((f) => f.label)).toEqual(['Alice']);
    expect(bob.body.map((f) => f.label)).toEqual(['Bob']);
  });

  /**
   * The id is guessable and travels in the URL. Holding one belonging to
   * somebody else must not be enough to rename it.
   */
  it('does not let one account rename another’s favorite', async () => {
    await seed();
    const aliceFavorite = await addFor(ALICE, 'Docs/alice', 'Alice');

    await request(buildApp(BOB))
      .patch(`/api/favorites/${aliceFavorite.id}`)
      .send({ label: 'taken over' });

    const alice = await request(buildApp(ALICE)).get('/api/favorites');
    expect(alice.body.map((f) => f.label)).toEqual(['Alice']);
  });

  it('does not let one account delete another’s favorite', async () => {
    await seed();
    await addFor(ALICE, 'Docs/alice', 'Alice');

    await request(buildApp(BOB)).delete('/api/favorites').send({ path: 'Docs/alice' });

    const alice = await request(buildApp(ALICE)).get('/api/favorites');
    expect(alice.body).toHaveLength(1);
  });

  it('does not let one account reorder another’s', async () => {
    await seed();
    const first = await addFor(ALICE, 'Docs/one', 'One');
    const second = await addFor(ALICE, 'Docs/two', 'Two');

    await request(buildApp(BOB))
      .patch('/api/favorites/reorder')
      .send({ order: [second.id, first.id] });

    const alice = await request(buildApp(ALICE)).get('/api/favorites');
    expect(alice.body.map((f) => f.label)).toEqual(['One', 'Two']);
  });
});

describe('managing one’s own favorites', () => {
  it('adds one and gives it back', async () => {
    await seed();

    const favorite = await addFor(ALICE, 'Docs/notes', 'Notes');

    expect(favorite).toMatchObject({ path: 'Docs/notes', label: 'Notes' });
  });

  it('renames one', async () => {
    await seed();
    const favorite = await addFor(ALICE, 'Docs/notes', 'Notes');

    const response = await request(buildApp(ALICE))
      .patch(`/api/favorites/${favorite.id}`)
      .send({ label: 'Renamed' });

    expect(response.status).toBe(200);
    const listed = await request(buildApp(ALICE)).get('/api/favorites');
    expect(listed.body.map((f) => f.label)).toEqual(['Renamed']);
  });

  it('removes one by its path', async () => {
    await seed();
    await addFor(ALICE, 'Docs/notes', 'Notes');

    await request(buildApp(ALICE)).delete('/api/favorites').send({ path: 'Docs/notes' });

    const listed = await request(buildApp(ALICE)).get('/api/favorites');
    expect(listed.body).toEqual([]);
  });

  it('reorders them', async () => {
    await seed();
    const first = await addFor(ALICE, 'Docs/one', 'One');
    const second = await addFor(ALICE, 'Docs/two', 'Two');

    const response = await request(buildApp(ALICE))
      .patch('/api/favorites/reorder')
      .send({ order: [second.id, first.id] });

    expect(response.status).toBe(200);
    expect(response.body.map((f) => f.label)).toEqual(['Two', 'One']);
  });
});

describe('a favorite that points nowhere', () => {
  it('says not found rather than failing, for a folder that is gone', async () => {
    await seed();

    const response = await request(buildApp(ALICE))
      .post('/api/favorites')
      .send({ path: 'Docs/deleted-yesterday', label: 'Gone' });

    expect(response.status).toBe(404);
  });

  it('refuses a file, since a favorite is a place to go', async () => {
    await seed();
    await nodeFs.writeFile(path.join(currentEnv.volumeDir, 'Docs', 'note.txt'), 'x');

    const response = await request(buildApp(ALICE))
      .post('/api/favorites')
      .send({ path: 'Docs/note.txt', label: 'Note' });

    expect(response.status).toBe(400);
  });
});
