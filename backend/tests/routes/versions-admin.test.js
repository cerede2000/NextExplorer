import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Every file that has a history, for an administrator.
 *
 * The routes beside these answer about one file, named by its path, with that
 * file's own rights — right for somebody looking at a document they have open,
 * and no use at all for "where has the space gone". A history whose file was
 * deleted outside the application has no file left to authorise against, and it
 * is exactly the kind nobody goes looking for.
 *
 * So a history is named here by its own id, and every route is behind the
 * administrator check.
 */

let env;
let app;
let users;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

const save = (who, file, content) =>
  request(app).put('/api/editor').set('x-test-user', who).send({ path: file, content });

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
});

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'versions-admin-' });

  const usersService = load('src/services/users');
  const make = (name, roles) =>
    usersService.createLocalUser({
      email: `${name}@example.com`,
      username: name,
      displayName: name[0].toUpperCase() + name.slice(1),
      password: 'secret123',
      roles,
    });
  users = { admin: await make('admin', ['admin']), alice: await make('alice', ['user']) };

  await fs.mkdir(volume('Notes'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who) req.user = users[who];
    next();
  });
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/versionsAdmin'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

/** Two saves make one version; that is the whole setup every test here needs. */
const withHistory = async (file) => {
  await save('alice', file, 'first');
  await save('alice', file, 'second');
};

describe('the list of files that have versions', () => {
  it('names every file with a history, and what it costs', async () => {
    await withHistory('Notes/journal.md');
    await withHistory('Notes/other.md');

    const response = await as('admin').get('/api/versions/admin/files');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.files.map((file) => file.name).sort()).toEqual(['journal.md', 'other.md']);
    expect(response.body.totalVersions).toBe(2);
    expect(response.body.totalBytes).toBeGreaterThan(0);
  });

  it('narrows to what the search names', async () => {
    await withHistory('Notes/journal.md');
    await withHistory('Notes/other.md');

    const response = await as('admin').get('/api/versions/admin/files?q=journal');

    expect(response.body.files.map((file) => file.name)).toEqual(['journal.md']);
  });

  it('refuses an order it does not know, rather than picking one', async () => {
    const response = await as('admin').get('/api/versions/admin/files?sort=whatever');

    expect(response.status).toBe(400);
  });

  it('is refused to somebody who is not an administrator', async () => {
    await withHistory('Notes/journal.md');

    expect((await as('alice').get('/api/versions/admin/files')).status).toBe(403);
  });

  it('is refused to nobody at all', async () => {
    expect((await request(app).get('/api/versions/admin/files')).status).toBe(403);
  });

  /** An administrator's list of what is on the disks is nobody's cache to keep. */
  it('is never cached', async () => {
    const response = await as('admin').get('/api/versions/admin/files');

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('one history, by its id', () => {
  it('reads back its versions', async () => {
    await withHistory('Notes/journal.md');
    const [file] = (await as('admin').get('/api/versions/admin/files')).body.files;

    const response = await as('admin').get(`/api/versions/admin/files/${file.id}`);

    expect(response.status).toBe(200);
    expect(response.body.file.name).toBe('journal.md');
    expect(response.body.versions).toHaveLength(1);
  });

  it('answers nothing for a history that does not exist', async () => {
    expect((await as('admin').get('/api/versions/admin/files/nosuch')).status).toBe(404);
  });

  it('is refused to somebody who is not an administrator', async () => {
    await withHistory('Notes/journal.md');
    const [file] = (await as('admin').get('/api/versions/admin/files')).body.files;

    expect((await as('alice').get(`/api/versions/admin/files/${file.id}`)).status).toBe(403);
  });
});

describe('deleting versions from the administrator side', () => {
  it('deletes the ones it is given, and leaves the file alone', async () => {
    await withHistory('Notes/journal.md');
    const [file] = (await as('admin').get('/api/versions/admin/files')).body.files;
    const { versions } = (await as('admin').get(`/api/versions/admin/files/${file.id}`)).body;

    const response = await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, {
      ids: [versions[0].id],
    });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(1);
    expect(await fs.readFile(volume('Notes/journal.md'), 'utf8')).toBe('second');
  });

  it('empties a whole history when asked to', async () => {
    await save('alice', 'Notes/journal.md', 'first');
    await save('alice', 'Notes/journal.md', 'second');
    await save('alice', 'Notes/journal.md', 'third');
    const [file] = (await as('admin').get('/api/versions/admin/files')).body.files;

    const response = await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, {
      all: true,
    });

    expect(response.body.deleted).toBe(2);
    expect(response.body.remaining).toBe(0);
    expect(await fs.readFile(volume('Notes/journal.md'), 'utf8')).toBe('third');
  });

  it('is refused to somebody who is not an administrator', async () => {
    await withHistory('Notes/journal.md');
    const [file] = (await as('admin').get('/api/versions/admin/files')).body.files;

    const response = await as('alice').post(`/api/versions/admin/files/${file.id}/delete`, {
      all: true,
    });

    expect(response.status).toBe(403);
    expect(
      (await as('admin').get(`/api/versions/admin/files/${file.id}`)).body.versions
    ).toHaveLength(1);
  });
});
