import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Every file that has a history, for an administrator.
 *
 * The routes beside these answer about one file by its path, with that file's
 * own rights. These answer "where has the space gone", which the panel could
 * never answer: the histories worth finding include files that are no longer
 * there, and a path nobody can name is a path nobody audits.
 *
 * What is checked here is the shape of that answer, and the two things that
 * make it safe to expose at all — that only an administrator reaches it, and
 * that deleting from it touches exactly the versions named and nothing else.
 */

let envContext;
let users;
let app;
let db;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const buildApp = () => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who) req.user = users[who];
    // An automation credential, to check that carrying an administrator's
    // account is not the same as being one.
    if (req.get('x-test-token')) req.apiToken = { id: 'token-1', scope: 'write' };
    next();
  });
  application.use('/api', load('src/routes/editor'));
  application.use('/api', load('src/routes/versionsAdmin'));
  application.use('/api', load('src/routes/versions'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
  put: (url, body) => request(app).put(url).set('x-test-user', who).send(body),
});

const list = (who = 'admin', query = '') => as(who).get(`/api/versions/admin/files${query}`);

/** Save through the text editor, as `who`: the ordinary way a version appears. */
const edit = async (who, filePath, content) => {
  const response = await as(who).put('/api/editor', { path: filePath, content });
  expect(response.status).toBe(200);
};

const rowFor = (body, name) => body.files.find((file) => file.name === name);

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'versions-admin-' });
  const usersService = load('src/services/users');
  const make = async (name, roles) =>
    usersService.createLocalUser({
      email: `${name}@example.com`,
      username: name,
      displayName: name[0].toUpperCase() + name.slice(1),
      password: 'secret123',
      roles,
    });
  users = {
    admin: await make('admin', ['admin']),
    alice: await make('alice', ['user']),
  };
  db = await load('src/services/db').getDb();
  app = buildApp();
  await write('Projects/notes.md', 'one\n');
  await write('Projects/report_2026.md', 'one\n');
  await write('Photos/holiday.txt', 'one\n');
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  vi.restoreAllMocks();
  await envContext.cleanup();
});

describe('who may read the list', () => {
  it('answers an administrator', async () => {
    const response = await list('admin');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ files: [], total: 0, totalBytes: 0 });
  });

  it('refuses somebody who is not one', async () => {
    const response = await list('alice');

    expect(response.status).toBe(403);
  });

  it('refuses an API token, whoever it belongs to', async () => {
    const response = await request(app)
      .get('/api/versions/admin/files')
      .set('x-test-user', 'admin')
      .set('x-test-token', 'yes');

    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/API token/i);
  });

  it('refuses one on the delete route too, which is the one that destroys', async () => {
    const response = await request(app)
      .post('/api/versions/admin/files/anything/delete')
      .set('x-test-user', 'admin')
      .set('x-test-token', 'yes')
      .send({ all: true });

    expect(response.status).toBe(403);
  });
});

describe('the list itself', () => {
  it('names every file that has versions, with what its history holds', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Projects/notes.md', 'three\n');
    await edit('alice', 'Photos/holiday.txt', 'a much longer second content\n');

    const response = await list();

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.totalVersions).toBe(3);
    // A zone is a top-level folder of the volume root, so `Projects` is the
    // zone and the history's path inside it is the file name. The address a
    // browser could open is the two put back together.
    expect(rowFor(response.body, 'notes.md')).toMatchObject({
      name: 'notes.md',
      relativePath: 'notes.md',
      folder: '',
      path: 'Projects/notes.md',
      state: 'live',
      versions: 2,
      zone: { kind: 'volume', name: 'Projects' },
    });
  });

  it('leaves out a file whose versions have all gone', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    const before = await list();
    const file = rowFor(before.body, 'notes.md');

    await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, { all: true });

    expect((await list()).body.files).toEqual([]);
  });

  it('orders by the space a history takes, which is the question being asked', async () => {
    await edit('alice', 'Projects/notes.md', 'x\n');
    await edit('alice', 'Photos/holiday.txt', `${'y'.repeat(500)}\n`);
    await edit('alice', 'Photos/holiday.txt', 'z\n');

    const response = await list();

    expect(response.body.files.map((file) => file.name)).toEqual(['holiday.txt', 'notes.md']);
    expect(response.body.files[0].bytes).toBeGreaterThan(response.body.files[1].bytes);
  });

  it('can be ordered by path instead', async () => {
    await edit('alice', 'Projects/notes.md', 'x\n');
    await edit('alice', 'Photos/holiday.txt', `${'y'.repeat(500)}\n`);

    const response = await list('admin', '?sort=path');

    expect(response.body.files.map((file) => file.path)).toEqual([
      'Photos/holiday.txt',
      'Projects/notes.md',
    ]);
  });

  it('refuses an order it does not have, rather than quietly using another', async () => {
    const response = await list('admin', '?sort=whatever');

    expect(response.status).toBe(400);
  });

  it('searches the path as it was typed, underscore and all', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Projects/report_2026.md', 'two\n');

    // `report_2026` as a LIKE pattern would match `report-2026` and anything
    // else with a character there. Nothing here should match but the one file.
    const response = await list('admin', '?q=report_2026');

    expect(response.body.files.map((file) => file.name)).toEqual(['report_2026.md']);
    expect(response.body.total).toBe(1);
  });

  it('narrows to a state, and counts only what the filter matched', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Photos/holiday.txt', 'two\n');
    const store = load('src/services/versions/store');
    const gone = rowFor((await list()).body, 'holiday.txt');
    store.setFileState(db, gone.id, 'orphaned', { orphanedAt: new Date().toISOString() });

    const orphaned = await list('admin', '?state=orphaned');

    expect(orphaned.body.files.map((file) => file.name)).toEqual(['holiday.txt']);
    expect(orphaned.body.total).toBe(1);
    expect((await list('admin', '?state=live')).body.total).toBe(1);
    expect((await list()).body.total).toBe(2);
  });

  it('pages, and says how many there are altogether rather than how many it sent', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Projects/report_2026.md', 'two\n');
    await edit('alice', 'Photos/holiday.txt', 'two\n');

    const first = await list('admin', '?limit=2&sort=path');
    const second = await list('admin', '?limit=2&offset=2&sort=path');

    expect(first.body.files).toHaveLength(2);
    expect(first.body.total).toBe(3);
    expect(second.body.files).toHaveLength(1);
    expect(second.body.total).toBe(3);
    expect(second.body.files[0].name).toBe('report_2026.md');
  });
});

describe('one history', () => {
  it('reads the versions of a history by its own id, newest first', async () => {
    await edit('alice', 'Projects/notes.md', 'second content\n');
    await edit('alice', 'Projects/notes.md', 'third\n');
    const file = rowFor((await list()).body, 'notes.md');

    const response = await as('admin').get(`/api/versions/admin/files/${file.id}`);

    expect(response.status).toBe(200);
    expect(response.body.file).toMatchObject({
      name: 'notes.md',
      path: 'Projects/notes.md',
      state: 'live',
    });
    expect(response.body.versions).toMatchObject([
      // What Alice replaced, so hers.
      { size: 15, author: { id: users.alice.id, label: 'Alice' }, source: 'editor' },
      // What the file held before the application ever wrote it.
      { size: 4, author: null, source: 'external' },
    ]);
    expect(response.body.totalBytes).toBe(19);
  });

  it('answers an id nothing has with not found', async () => {
    const response = await as('admin').get('/api/versions/admin/files/nothing');

    expect(response.status).toBe(404);
  });
});

describe('deleting from it', () => {
  it('deletes the versions named and leaves the others', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Projects/notes.md', 'three\n');
    const file = rowFor((await list()).body, 'notes.md');
    const before = (await as('admin').get(`/api/versions/admin/files/${file.id}`)).body.versions;

    const response = await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, {
      ids: [before[0].id],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ deleted: 1, remaining: 1 });
    const after = (await as('admin').get(`/api/versions/admin/files/${file.id}`)).body.versions;
    expect(after.map((version) => version.id)).toEqual([before[1].id]);
    // The file is a file, not a version of one.
    expect(await fs.readFile(volume('Projects/notes.md'), 'utf8')).toBe('three\n');
  });

  it('refuses a version that belongs to another file, and leaves it alone', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    await edit('alice', 'Photos/holiday.txt', 'two\n');
    const mine = rowFor((await list()).body, 'notes.md');
    const other = rowFor((await list()).body, 'holiday.txt');
    const theirs = (await as('admin').get(`/api/versions/admin/files/${other.id}`)).body
      .versions[0];

    const response = await as('admin').post(`/api/versions/admin/files/${mine.id}/delete`, {
      ids: [theirs.id],
    });

    expect(response.body.items).toEqual([{ id: theirs.id, status: 'not-found' }]);
    expect(response.body.deleted).toBe(0);
    const survivors = (await as('admin').get(`/api/versions/admin/files/${other.id}`)).body
      .versions;
    expect(survivors.map((version) => version.id)).toEqual([theirs.id]);
  });

  it('keeps the row of a file that is still there, because the next save reads it', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    const file = rowFor((await list()).body, 'notes.md');

    await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, { all: true });

    expect(load('src/services/versions/store').getFile(db, file.id)).not.toBeNull();
  });

  it('takes the row with it when the file itself is gone', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    const store = load('src/services/versions/store');
    const file = rowFor((await list()).body, 'notes.md');
    store.setFileState(db, file.id, 'orphaned', { orphanedAt: new Date().toISOString() });

    await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, { all: true });

    expect(store.getFile(db, file.id)).toBeNull();
  });

  it('refuses a request that names nothing at all', async () => {
    await edit('alice', 'Projects/notes.md', 'two\n');
    const file = rowFor((await list()).body, 'notes.md');

    const response = await as('admin').post(`/api/versions/admin/files/${file.id}/delete`, {});

    expect(response.status).toBe(400);
  });
});
