import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The trash through the API, the way the interface uses it: deleting sends an
 * entry to the trash, the trash shows each person what is theirs to see, and
 * restoring puts it back — for whoever may still write there.
 */

let envContext;
let users;
let app;
let db;
let store;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const write = async (relative, content = 'content') => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const exists = (absolutePath) =>
  fs.lstat(absolutePath).then(
    () => true,
    () => false
  );

const buildApp = () => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who?.startsWith('guest:')) {
      req.guestSession = { id: 'guest-session', shareId: who.slice('guest:'.length) };
    } else if (who) {
      req.user = users[who];
    }
    next();
  });
  application.use('/api', load('src/routes/files'));
  application.use('/api', load('src/routes/trash'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
  del: (url, body) => request(app).delete(url).set('x-test-user', who).send(body),
});

const deleteAs = (who, parent, name, extra = {}) =>
  as(who).del('/api/files', { items: [{ path: parent, name }], ...extra });

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'trash-routes-',
    env: { USER_DIR_ENABLED: 'true', SHARES_ENABLED: 'true' },
  });
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
    bob: await make('bob', ['user']),
  };
  db = await load('src/services/db').getDb();
  store = load('src/services/trash/store');
  app = buildApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await envContext.cleanup();
});

describe('deleting', () => {
  it('sends an entry to the trash rather than removing it', async () => {
    await write('Projects/report.txt', 'quarterly figures');

    const response = await deleteAs('alice', 'Projects', 'report.txt');

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      { path: 'Projects/report.txt', status: 'trashed', trashItemId: expect.any(String) },
    ]);
    expect(await exists(volume('Projects/report.txt'))).toBe(false);
    const [item] = store.listItems(db);
    expect(item).toMatchObject({ name: 'report.txt', state: 'trashed', deletedBy: users.alice.id });
  });

  it('removes for good when asked to', async () => {
    await write('Projects/report.txt');

    const response = await deleteAs('alice', 'Projects', 'report.txt', { permanent: true });

    expect(response.body.items).toEqual([{ path: 'Projects/report.txt', status: 'deleted' }]);
    expect(store.listItems(db)).toEqual([]);
    expect(await exists(volume('Projects/report.txt'))).toBe(false);
  });

  it('removes for good when the trash is switched off', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'trash', {
      enabled: false,
    });
    await write('Projects/report.txt');

    const response = await deleteAs('alice', 'Projects', 'report.txt');

    expect(response.body.items[0].status).toBe('deleted');
    expect(store.listItems(db)).toEqual([]);
  });

  /** Never a permanent deletion nobody was told about: the entry stays, and the answer says why. */
  it('keeps an entry the trash cannot take, and says why', async () => {
    await write('Projects/mount/report.txt');
    const zones = load('src/services/trash/zones');
    vi.spyOn(zones, 'deviceOf').mockImplementation(async (target) =>
      target.includes('mount') ? 2 : 1
    );

    const response = await deleteAs('alice', 'Projects/mount', 'report.txt');

    expect(response.body.items).toEqual([
      { path: 'Projects/mount/report.txt', status: 'kept', reason: 'other-device' },
    ]);
    expect(await exists(volume('Projects/mount/report.txt'))).toBe(true);
  });

  it('keeps an entry larger than the whole trash, and says how large', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'trash', {
      maxBytes: 4,
    });
    await write('Projects/big.bin', '0123456789');

    const response = await deleteAs('alice', 'Projects', 'big.bin');

    expect(response.body.items).toEqual([
      { path: 'Projects/big.bin', status: 'kept', reason: 'too-large', size: 10, budgetBytes: 4 },
    ]);
    expect(await exists(volume('Projects/big.bin'))).toBe(true);
  });

  it('does the same through the streamed deletion', async () => {
    await write('Projects/a.txt');
    await write('Projects/b.txt');

    const trashed = await as('alice').post('/api/files/delete-stream', {
      items: [{ path: 'Projects', name: 'a.txt' }],
    });
    const removed = await as('alice').post('/api/files/delete-stream', {
      items: [{ path: 'Projects', name: 'b.txt' }],
      permanent: true,
    });

    const done = (response) =>
      response.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'done');
    expect(done(trashed).items[0].status).toBe('trashed');
    expect(done(removed).items[0].status).toBe('deleted');
    expect(store.listItems(db).map((item) => item.name)).toEqual(['a.txt']);
  });

  it('forgets the favorites that pointed at what went to the trash', async () => {
    await fs.mkdir(volume('Projects/client'), { recursive: true });
    const favorites = load('src/services/favoritesService');
    await favorites.addFavorite(users.alice, { path: 'Projects/client' });

    const response = await deleteAs('alice', 'Projects', 'client');

    expect(response.body.items[0]).toMatchObject({ status: 'trashed', removedFavoriteCount: 1 });
    expect(await favorites.getFavorites(users.alice.id)).toEqual([]);
  });
});

describe('what deleting will do, asked before confirming', () => {
  it('says which items go to the trash and which would be gone for good', async () => {
    await write('Projects/report.txt');
    await write('Projects/mount/other.txt');
    const zones = load('src/services/trash/zones');
    vi.spyOn(zones, 'deviceOf').mockImplementation(async (target) =>
      target.includes('mount') ? 2 : 1
    );

    const response = await as('alice').post('/api/files/delete-impact', {
      items: [
        { path: 'Projects', name: 'report.txt' },
        { path: 'Projects/mount', name: 'other.txt' },
      ],
    });

    expect(response.body.trash).toEqual({
      enabled: true,
      retentionDays: 30,
      items: [
        { path: 'Projects/report.txt', disposition: 'trash', reason: null, shareCount: 0 },
        {
          path: 'Projects/mount/other.txt',
          disposition: 'permanent',
          reason: 'other-device',
          shareCount: 0,
        },
      ],
    });
  });

  it('says everything is permanent when the trash is off', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'trash', {
      enabled: false,
    });
    await write('Projects/report.txt');

    const response = await as('alice').post('/api/files/delete-impact', {
      items: [{ path: 'Projects', name: 'report.txt' }],
    });

    expect(response.body.trash.items).toEqual([
      { path: 'Projects/report.txt', disposition: 'permanent', reason: 'disabled', shareCount: 0 },
    ]);
  });

  it('says a file larger than the whole trash would be gone for good', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'trash', {
      maxBytes: 4,
    });
    await write('Projects/big.bin', '0123456789');

    const response = await as('alice').post('/api/files/delete-impact', {
      items: [{ path: 'Projects', name: 'big.bin' }],
    });

    expect(response.body.trash.items[0]).toMatchObject({
      disposition: 'permanent',
      reason: 'too-large',
    });
  });
});

describe('what each person sees', () => {
  beforeEach(async () => {
    await write('Projects/alice.txt');
    await write('Projects/bob.txt');
    await deleteAs('alice', 'Projects', 'alice.txt');
    await deleteAs('bob', 'Projects', 'bob.txt');
  });

  it('is what they deleted, with where it was, who, when, and until when', async () => {
    const response = await as('alice').get('/api/trash');

    expect(response.status).toBe(200);
    expect(response.body.retentionDays).toBe(30);
    expect(response.body.items).toHaveLength(1);
    const [item] = response.body.items;
    expect(item).toMatchObject({
      name: 'alice.txt',
      kind: 'file',
      size: 'content'.length,
      deletedBy: { id: users.alice.id, label: 'Alice', isYou: true },
      location: { kind: 'volume', name: 'Projects', parent: '' },
      openPath: 'Projects',
      available: true,
    });
    expect(Date.parse(item.expiresAt) - Date.parse(item.deletedAt)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('is everything, for an administrator', async () => {
    const response = await as('admin').get('/api/trash');

    expect(response.body.items.map((item) => item.name).sort()).toEqual(['alice.txt', 'bob.txt']);
  });

  it('is nothing, for a share visitor', async () => {
    const response = await as('guest:some-share').get('/api/trash');

    expect(response.status).toBe(403);
  });
});

describe('restoring', () => {
  it('puts the item back and says where to find it', async () => {
    await write('Projects/a/report.txt', 'quarterly figures');
    const deleted = await deleteAs('alice', 'Projects/a', 'report.txt');

    const response = await as('alice').post('/api/trash/restore', {
      ids: [deleted.body.items[0].trashItemId],
    });

    expect(response.body.items).toEqual([
      {
        id: deleted.body.items[0].trashItemId,
        status: 'restored',
        name: 'report.txt',
        restoredName: 'report.txt',
        renamed: false,
        path: 'Projects/a',
      },
    ]);
    expect(await fs.readFile(volume('Projects/a/report.txt'), 'utf8')).toBe('quarterly figures');
    expect((await as('alice').get('/api/trash')).body.items).toEqual([]);
  });

  it('gives a new name when the old one is taken, and says so', async () => {
    await write('Projects/report.txt', 'deleted');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    await write('Projects/report.txt', 'new');

    const response = await as('alice').post('/api/trash/restore', {
      ids: [deleted.body.items[0].trashItemId],
    });

    expect(response.body.items[0]).toMatchObject({
      status: 'restored',
      restoredName: 'report (1).txt',
      renamed: true,
    });
  });

  it('is not possible for someone else’s item, which they cannot even see', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    const id = deleted.body.items[0].trashItemId;

    const response = await as('bob').post('/api/trash/restore', { ids: [id] });

    expect(response.body.items).toEqual([{ id, status: 'not-found' }]);
    expect(await exists(volume('Projects/report.txt'))).toBe(false);
  });

  /** Access taken away after the deletion is not given back by the trash. */
  it('is refused to someone who can no longer write where it goes back', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    const id = deleted.body.items[0].trashItemId;
    await load('src/services/settingsService').setSystemSetting('system', 'access', {
      rules: [{ path: 'Projects', recursive: true, permissions: 'ro' }],
    });

    const response = await as('alice').post('/api/trash/restore', { ids: [id] });

    expect(response.body.items).toEqual([{ id, status: 'forbidden', name: 'report.txt' }]);
    expect(await exists(volume('Projects/report.txt'))).toBe(false);
  });

  it('is possible for an administrator, whoever deleted it', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');

    const response = await as('admin').post('/api/trash/restore', {
      ids: [deleted.body.items[0].trashItemId],
    });

    expect(response.body.items[0]).toMatchObject({ status: 'restored', path: 'Projects' });
  });

  it('refuses a request with no items, or with something that is not an id', async () => {
    expect((await as('alice').post('/api/trash/restore', { ids: [] })).status).toBe(400);
    expect((await as('alice').post('/api/trash/restore', { ids: [42] })).status).toBe(400);
    expect((await as('alice').post('/api/trash/restore', {})).status).toBe(400);
  });
});

describe('inside a deleted folder', () => {
  const deleteClient = async (who = 'alice') => {
    await write('Projects/client/brief.txt', 'the brief');
    await write('Projects/client/drafts/v1.txt', 'first draft');
    await write('Projects/client/drafts/v2.txt', 'second, longer draft');
    const deleted = await deleteAs(who, 'Projects', 'client');
    return deleted.body.items[0].trashItemId;
  };
  const entries = (who, id, query = '') => as(who).get(`/api/trash/items/${id}/entries${query}`);
  const restore = (who, id, body) => as(who).post(`/api/trash/items/${id}/restore`, body);

  it('shows what it holds, at its top and further in', async () => {
    const id = await deleteClient();

    const top = await entries('alice', id);
    const inner = await entries('alice', id, '?path=drafts');

    expect(top.status).toBe(200);
    expect(top.body).toMatchObject({ path: '', item: { id, name: 'client', kind: 'directory' } });
    expect(top.body.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ['drafts', 'directory', null],
      ['brief.txt', 'file', 'the brief'.length],
    ]);
    expect(inner.body.path).toBe('drafts');
    expect(inner.body.entries.map((entry) => entry.name)).toEqual(['v1.txt', 'v2.txt']);
  });

  it('is shown to whoever sees the folder in their trash, and to nobody else', async () => {
    const id = await deleteClient();

    expect((await entries('admin', id)).status).toBe(200);
    expect((await entries('bob', id)).status).toBe(404);
    expect((await entries('guest:some-share', id)).status).toBe(403);
  });

  it('refuses a path that climbs out, and says when nothing, or no folder, is there', async () => {
    const id = await deleteClient();

    expect((await entries('alice', id, '?path=..')).status).toBe(400);
    expect((await entries('alice', id, '?path=drafts%2F..%2F..')).status).toBe(400);
    expect((await entries('alice', id, '?path=a&path=b')).status).toBe(400);
    expect((await entries('alice', id, '?path=nowhere')).status).toBe(404);
    expect((await entries('alice', id, '?path=brief.txt')).status).toBe(400);
  });

  it('says so when the volume it was deleted from is not there', async () => {
    const id = await deleteClient();
    await fs.rm(volume('Projects', '.nextexplorer', 'zone.json'));

    expect((await entries('alice', id)).status).toBe(409);
  });

  it('gives back one file where it was, says where to find it, and keeps the rest', async () => {
    const id = await deleteClient();

    const response = await restore('alice', id, { paths: ['drafts/v2.txt'] });

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      {
        entry: 'drafts/v2.txt',
        status: 'restored',
        name: 'v2.txt',
        restoredName: 'v2.txt',
        renamed: false,
        path: 'Projects/client/drafts',
      },
    ]);
    expect(await fs.readFile(volume('Projects/client/drafts/v2.txt'), 'utf8')).toBe(
      'second, longer draft'
    );
    expect((await as('alice').get('/api/trash')).body.items).toEqual([
      expect.objectContaining({
        id,
        name: 'client',
        size: 'the brief'.length + 'first draft'.length,
      }),
    ]);
  });

  it('gives back several entries at once, each where it was', async () => {
    const id = await deleteClient();

    const response = await restore('alice', id, { paths: ['brief.txt', 'drafts/v1.txt'] });

    expect(response.body.items.map((result) => [result.entry, result.status, result.path])).toEqual(
      [
        ['brief.txt', 'restored', 'Projects/client'],
        ['drafts/v1.txt', 'restored', 'Projects/client/drafts'],
      ]
    );
    const left = await entries('alice', id, '?path=drafts');
    expect(left.body.entries.map((entry) => entry.name)).toEqual(['v2.txt']);
  });

  /** The right to restore the folder is the right to restore what is in it. */
  it('is refused to someone who can no longer write where the folder was', async () => {
    const id = await deleteClient();
    await load('src/services/settingsService').setSystemSetting('system', 'access', {
      rules: [{ path: 'Projects', recursive: true, permissions: 'ro' }],
    });

    const response = await restore('alice', id, { paths: ['brief.txt'] });

    expect(response.body.items).toEqual([
      { entry: 'brief.txt', status: 'forbidden', name: 'brief.txt' },
    ]);
    expect(await exists(volume('Projects/client'))).toBe(false);
  });

  it('is possible for an administrator, and not for someone who cannot see the folder', async () => {
    const id = await deleteClient();

    expect((await restore('bob', id, { paths: ['brief.txt'] })).status).toBe(404);
    expect(await exists(volume('Projects/client'))).toBe(false);

    const byAdmin = await restore('admin', id, { paths: ['brief.txt'] });
    expect(byAdmin.body.items[0]).toMatchObject({ status: 'restored', path: 'Projects/client' });
  });

  it('refuses no entries, a path that climbs out, and an entry inside another one asked for', async () => {
    const id = await deleteClient();

    expect((await restore('alice', id, { paths: [] })).status).toBe(400);
    expect((await restore('alice', id, {})).status).toBe(400);
    expect((await restore('alice', id, { paths: ['../escape.txt'] })).status).toBe(400);
    expect((await restore('alice', id, { paths: [''] })).status).toBe(400);
    expect((await restore('alice', id, { paths: ['drafts', 'drafts/v1.txt'] })).status).toBe(400);
    expect(await exists(volume('Projects/client'))).toBe(false);
  });

  it('works in a personal folder, and names the folder to open there', async () => {
    const { resolvePersonalPath } = load('src/utils/pathUtils');
    const personalFile = await resolvePersonalPath('notes/day/today.txt', users.alice);
    await fs.mkdir(path.dirname(personalFile), { recursive: true });
    await fs.writeFile(personalFile, 'dear diary');
    const deleted = await deleteAs('alice', 'personal/notes', 'day');
    const id = deleted.body.items[0].trashItemId;

    const response = await restore('alice', id, { paths: ['today.txt'] });

    expect(response.body.items[0]).toMatchObject({
      status: 'restored',
      path: 'personal/notes/day',
    });
    expect(await fs.readFile(personalFile, 'utf8')).toBe('dear diary');
  });
});

/** Reading a file before deciding what to do with it — and only reading it. */
describe('reading a file in the trash', () => {
  const text = (who, id, query = '') => as(who).get(`/api/trash/items/${id}/text${query}`);
  const script = '#!/bin/sh\necho hello\n';

  it('gives the text of a deleted script, never cached', async () => {
    await write('Projects/script.sh', script);
    const id = (await deleteAs('alice', 'Projects', 'script.sh')).body.items[0].trashItemId;

    const response = await text('alice', id);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      name: 'script.sh',
      size: script.length,
      content: script,
      modifiedAt: expect.any(String),
    });
  });

  it('sends a large file compressed, and still never cached', async () => {
    const log = 'Statut : à jour, rien à signaler\n'.repeat(3000);
    await write('Projects/big.log', log);
    const id = (await deleteAs('alice', 'Projects', 'big.log')).body.items[0].trashItemId;

    const response = await text('alice', id).set('Accept-Encoding', 'gzip, deflate');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({ name: 'big.log', content: log });
  });

  it('gives the text of a file inside a deleted folder', async () => {
    await write('Projects/client/drafts/v1.txt', 'first draft');
    const id = (await deleteAs('alice', 'Projects', 'client')).body.items[0].trashItemId;

    const response = await text('alice', id, '?path=drafts%2Fv1.txt');

    expect(response.body).toMatchObject({ name: 'v1.txt', content: 'first draft' });
  });

  it('refuses what is not text, as the editor does', async () => {
    await fs.mkdir(volume('Projects'), { recursive: true });
    await fs.writeFile(volume('Projects/photo.bin'), Buffer.from([0, 159, 146, 150, 0, 0, 1, 2]));
    const id = (await deleteAs('alice', 'Projects', 'photo.bin')).body.items[0].trashItemId;

    expect((await text('alice', id)).status).toBe(415);
  });

  it('is for whoever sees the item in their trash, and only for a file in it', async () => {
    await write('Projects/client/drafts/v1.txt', 'first draft');
    const id = (await deleteAs('alice', 'Projects', 'client')).body.items[0].trashItemId;

    expect((await text('admin', id, '?path=drafts%2Fv1.txt')).status).toBe(200);
    expect((await text('bob', id, '?path=drafts%2Fv1.txt')).status).toBe(404);
    expect((await text('guest:some-share', id, '?path=drafts%2Fv1.txt')).status).toBe(403);
    expect((await text('alice', id)).status).toBe(400);
    expect((await text('alice', id, '?path=drafts')).status).toBe(400);
    expect((await text('alice', id, '?path=..%2F..%2Fsecret')).status).toBe(400);
    expect((await text('alice', id, '?path=drafts%2Fnowhere.txt')).status).toBe(404);
  });

  /** A look, never an edit: nothing answers a write to the trash's files. */
  it('offers no way to write the file', async () => {
    await write('Projects/script.sh', script);
    const id = (await deleteAs('alice', 'Projects', 'script.sh')).body.items[0].trashItemId;

    const put = await as('alice').post(`/api/trash/items/${id}/text`, { content: 'changed' });
    const replaced = await request(app)
      .put(`/api/trash/items/${id}/text`)
      .set('x-test-user', 'alice')
      .send({ content: 'changed' });

    expect(put.status).toBe(404);
    expect(replaced.status).toBe(404);
    expect((await text('alice', id)).body.content).toBe(script);
  });
});

/**
 * Restoring into a folder someone chose. It streams, as a transfer does, since
 * across disks it is a copy; everything it can refuse is refused before the
 * stream starts.
 */
describe('restoring into a chosen folder', () => {
  const events = (response) =>
    response.text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const doneOf = (response) => events(response).find((event) => event.type === 'done');
  const restoreTo = (who, body) => as(who).post('/api/trash/restore-to', body);
  const restoreEntriesTo = (who, id, body) =>
    as(who).post(`/api/trash/items/${id}/restore-to`, body);
  const refusedOutright = (response) => response.status >= 400 && response.status < 500;
  const trashOne = async (who, relative, content = 'content') => {
    await write(relative, content);
    const deleted = await deleteAs(
      who,
      path.posix.dirname(relative),
      path.posix.basename(relative)
    );
    return deleted.body.items[0].trashItemId;
  };

  beforeEach(async () => {
    await fs.mkdir(volume('Archive'), { recursive: true });
  });

  it('puts items in the chosen folder, says how far it got, and remembers the folder', async () => {
    const id = await trashOne('alice', 'Projects/a/report.txt', 'quarterly figures');

    const response = await restoreTo('alice', { ids: [id], destination: 'Archive' });

    expect(response.status).toBe(200);
    const stream = events(response);
    expect(stream[0]).toEqual({
      type: 'start',
      totalBytes: 'quarterly figures'.length,
      totalItems: 1,
      destination: 'Archive',
    });
    expect(
      stream.some(
        (event) =>
          event.type === 'progress' &&
          event.completedItems === 1 &&
          event.copiedBytes === 'quarterly figures'.length
      )
    ).toBe(true);
    expect(doneOf(response)).toEqual({
      type: 'done',
      destination: 'Archive',
      items: [
        {
          id,
          status: 'restored',
          name: 'report.txt',
          restoredName: 'report.txt',
          renamed: false,
          path: 'Archive',
        },
      ],
    });
    expect(await fs.readFile(volume('Archive/report.txt'), 'utf8')).toBe('quarterly figures');
    expect(await exists(volume('Projects/a/report.txt'))).toBe(false);
    const recents = await as('alice').get('/api/files/recent-destinations');
    expect(recents.body.items).toContain('Archive');
  });

  it('puts entries of a deleted folder in the chosen folder, across disks too', async () => {
    await write('Projects/client/brief.txt', 'the brief');
    await write('Projects/client/drafts/v1.txt', 'first draft');
    const id = (await deleteAs('alice', 'Projects', 'client')).body.items[0].trashItemId;
    vi.spyOn(load('src/services/trash/zones'), 'sameDevice').mockResolvedValue(false);

    const response = await restoreEntriesTo('alice', id, {
      paths: ['drafts'],
      destination: 'Archive',
    });

    expect(doneOf(response).items).toEqual([
      {
        entry: 'drafts',
        status: 'restored',
        name: 'drafts',
        restoredName: 'drafts',
        renamed: false,
        path: 'Archive',
      },
    ]);
    expect(await fs.readFile(volume('Archive/drafts/v1.txt'), 'utf8')).toBe('first draft');
    const left = await as('alice').get(`/api/trash/items/${id}/entries`);
    expect(left.body.entries.map((entry) => entry.name)).toEqual(['brief.txt']);
  });

  it('refuses before anything moves: no folder, not a folder, nowhere, inside a trash', async () => {
    const id = await trashOne('alice', 'Projects/report.txt');
    await write('Archive/file.txt');

    expect((await restoreTo('alice', { ids: [id] })).status).toBe(400);
    expect((await restoreTo('alice', { ids: [], destination: 'Archive' })).status).toBe(400);
    for (const destination of ['Archive/file.txt', 'Archive/nowhere', 'Projects/.nextexplorer']) {
      const response = await restoreTo('alice', { ids: [id], destination });
      expect(refusedOutright(response), destination).toBe(true);
    }
    expect(
      (await restoreTo('guest:some-share', { ids: [id], destination: 'Archive' })).status
    ).toBe(403);
    expect(store.getItem(db, id).state).toBe('trashed');
  });

  it('refuses the entries of a folder someone cannot see, before anything moves', async () => {
    await write('Projects/client/brief.txt');
    const id = (await deleteAs('alice', 'Projects', 'client')).body.items[0].trashItemId;

    const response = await restoreEntriesTo('bob', id, {
      paths: ['brief.txt'],
      destination: 'Archive',
    });

    expect(response.status).toBe(404);
  });

  it('says so for an item that is not in their trash', async () => {
    const id = await trashOne('alice', 'Projects/report.txt');

    const response = await restoreTo('bob', { ids: [id], destination: 'Archive' });

    expect(doneOf(response).items).toEqual([{ id, status: 'not-found' }]);
    expect(await exists(volume('Archive/report.txt'))).toBe(false);
  });

  it('is refused when the chosen folder does not let them create there', async () => {
    const id = await trashOne('alice', 'Projects/report.txt');
    await load('src/services/settingsService').setSystemSetting('system', 'access', {
      rules: [{ path: 'Archive', recursive: true, permissions: 'ro' }],
    });

    const response = await restoreTo('alice', { ids: [id], destination: 'Archive' });

    expect(doneOf(response).items).toEqual([
      { id, status: 'forbidden', reason: 'destination', name: 'report.txt' },
    ]);
    expect(await exists(volume('Archive/report.txt'))).toBe(false);
  });

  /** Somewhere else is not a way around an access taken away since the deletion. */
  it('is refused to someone who can no longer write where the item came from', async () => {
    const id = await trashOne('alice', 'Projects/report.txt');
    await load('src/services/settingsService').setSystemSetting('system', 'access', {
      rules: [{ path: 'Projects', recursive: true, permissions: 'ro' }],
    });

    const response = await restoreTo('alice', { ids: [id], destination: 'Archive' });

    expect(doneOf(response).items).toEqual([{ id, status: 'forbidden', name: 'report.txt' }]);
    expect(await exists(volume('Archive/report.txt'))).toBe(false);
  });

  it('is possible for an administrator, whoever deleted the item', async () => {
    const id = await trashOne('alice', 'Projects/report.txt', 'from alice');

    const response = await restoreTo('admin', { ids: [id], destination: 'Archive' });

    expect(doneOf(response).items[0]).toMatchObject({ status: 'restored', path: 'Archive' });
    expect(await fs.readFile(volume('Archive/report.txt'), 'utf8')).toBe('from alice');
  });
});

/**
 * The share links of what goes to the trash: switched off at once, kept with
 * the item, brought back or let go as the person restoring chooses, pointed at
 * wherever the content comes back to, and gone for good with the item.
 */
describe('share links in the trash', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let shares;

  beforeEach(() => {
    shares = load('src/services/sharesService');
  });

  const shareOn = (sourcePath, overrides = {}) =>
    shares.createShare({
      ownerId: users.alice.id,
      sourceSpace: 'volume',
      sourcePath,
      isDirectory: false,
      accessMode: 'readonly',
      label: 'For the client',
      password: 'open sesame',
      expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
      ...overrides,
    });
  const kept = () =>
    db
      .prepare('SELECT share_id, item_id, relative_path FROM trash_shares ORDER BY relative_path')
      .all();
  const trashFile = async (relative, content = 'content') => {
    await write(relative, content);
    const deleted = await deleteAs(
      'alice',
      path.posix.dirname(relative),
      path.posix.basename(relative)
    );
    return deleted.body.items[0];
  };
  const restore = (who, body) => as(who).post('/api/trash/restore', body);
  const doneOf = (response) =>
    response.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'done');

  it('switches a share off as its file goes to the trash, and keeps it with the item', async () => {
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt');

    const impact = await as('alice').post('/api/files/delete-impact', {
      items: [{ path: 'Projects', name: 'report.txt' }],
    });
    expect(impact.body.trash.items[0]).toMatchObject({ disposition: 'trash', shareCount: 1 });

    const deleted = await deleteAs('alice', 'Projects', 'report.txt');

    expect(deleted.body.items[0]).toMatchObject({ status: 'trashed', deletedShareCount: 1 });
    expect(await shares.getShareById(share.id)).toBeNull();
    expect(kept()).toEqual([
      { share_id: share.id, item_id: deleted.body.items[0].trashItemId, relative_path: '' },
    ]);
    expect((await as('alice').get('/api/trash')).body.items[0].shareCount).toBe(1);
  });

  it('brings the share back as it was when asked to: same link, password, label and expiry', async () => {
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt');
    const { trashItemId: id } = (await deleteAs('alice', 'Projects', 'report.txt')).body.items[0];

    const response = await restore('alice', { ids: [id], shares: 'restore' });

    expect(response.body.items[0]).toMatchObject({
      status: 'restored',
      sharesRestored: 1,
      sharesDropped: 0,
    });
    expect(await shares.getShareById(share.id)).toMatchObject({
      shareToken: share.shareToken,
      sourcePath: 'Projects/report.txt',
      label: 'For the client',
      hasPassword: true,
      expiresAt: share.expiresAt,
    });
    expect(await shares.verifySharePassword(share.id, 'open sesame')).toBe(true);
    expect(kept()).toEqual([]);
  });

  it('lets the share go when asked to, and when nothing is said', async () => {
    await write('Projects/a.txt');
    await write('Projects/b.txt');
    const first = await shareOn('Projects/a.txt');
    const second = await shareOn('Projects/b.txt');
    const a = (await deleteAs('alice', 'Projects', 'a.txt')).body.items[0].trashItemId;
    const b = (await deleteAs('alice', 'Projects', 'b.txt')).body.items[0].trashItemId;

    const dropped = await restore('alice', { ids: [a], shares: 'drop' });
    const unsaid = await restore('alice', { ids: [b] });

    expect(dropped.body.items[0]).toMatchObject({ sharesRestored: 0, sharesDropped: 1 });
    expect(unsaid.body.items[0]).toMatchObject({ sharesRestored: 0, sharesDropped: 1 });
    expect(await shares.getShareById(first.id)).toBeNull();
    expect(await shares.getShareById(second.id)).toBeNull();
    expect(kept()).toEqual([]);
  });

  it('deletes it for good with the item deleted for good from the trash', async () => {
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt');
    const { trashItemId: id } = (await deleteAs('alice', 'Projects', 'report.txt')).body.items[0];

    await as('alice').post('/api/trash/delete', { ids: [id] });

    expect(kept()).toEqual([]);
    expect(await shares.getShareById(share.id)).toBeNull();
  });

  it('keeps nothing of a share when its file is deleted for good straight away', async () => {
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt');

    const deleted = await deleteAs('alice', 'Projects', 'report.txt', { permanent: true });

    expect(deleted.body.items[0]).toMatchObject({ status: 'deleted', deletedShareCount: 1 });
    expect(kept()).toEqual([]);
    expect(await shares.getShareById(share.id)).toBeNull();
  });

  it('points the share at the name the file came back under', async () => {
    await write('Projects/report.txt', 'deleted');
    const share = await shareOn('Projects/report.txt');
    const { trashItemId: id } = (await deleteAs('alice', 'Projects', 'report.txt')).body.items[0];
    await write('Projects/report.txt', 'written since');

    await restore('alice', { ids: [id], shares: 'restore' });

    expect((await shares.getShareById(share.id)).sourcePath).toBe('Projects/report (1).txt');
  });

  it('keeps the shares inside a deleted folder, and brings back those of the entries restored', async () => {
    await write('Projects/client/brief.txt');
    await write('Projects/client/drafts/v1.txt');
    const folderShare = await shareOn('Projects/client', { isDirectory: true });
    const fileShare = await shareOn('Projects/client/drafts/v1.txt');
    const id = (await deleteAs('alice', 'Projects', 'client')).body.items[0].trashItemId;

    expect(kept().map((row) => row.relative_path)).toEqual(['', 'drafts/v1.txt']);
    const inside = await as('alice').get(`/api/trash/items/${id}/entries?path=drafts`);
    expect(inside.body.item.shareCount).toBe(2);
    expect(inside.body.entries).toEqual([
      expect.objectContaining({ name: 'v1.txt', shareCount: 1 }),
    ]);

    const response = await as('alice').post(`/api/trash/items/${id}/restore`, {
      paths: ['drafts'],
      shares: 'restore',
    });

    expect(response.body.items[0]).toMatchObject({ status: 'restored', sharesRestored: 1 });
    expect((await shares.getShareById(fileShare.id)).sourcePath).toBe(
      'Projects/client/drafts/v1.txt'
    );
    expect(kept().map((row) => row.share_id)).toEqual([folderShare.id]);

    await as('alice').post('/api/trash/delete', { ids: [id] });
    expect(kept()).toEqual([]);
    expect(await shares.getShareById(folderShare.id)).toBeNull();
  });

  it('follows content restored somewhere else', async () => {
    await fs.mkdir(volume('Archive'), { recursive: true });
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt');
    const { trashItemId: id } = (await deleteAs('alice', 'Projects', 'report.txt')).body.items[0];

    const response = await as('alice').post('/api/trash/restore-to', {
      ids: [id],
      destination: 'Archive',
      shares: 'restore',
    });

    expect(doneOf(response).items[0]).toMatchObject({ status: 'restored', sharesRestored: 1 });
    expect(await shares.getShareById(share.id)).toMatchObject({
      sourceSpace: 'volume',
      sourcePath: 'Archive/report.txt',
      shareToken: share.shareToken,
    });
  });

  /** Pointing someone else's link at a place of one's choosing is not one's call. */
  it('brings elsewhere only the shares of the person restoring, unless they administer', async () => {
    await fs.mkdir(volume('Archive'), { recursive: true });
    await write('Projects/a.txt');
    await write('Projects/b.txt');
    const alicesOnA = await shareOn('Projects/a.txt');
    const adminsOnA = await shareOn('Projects/a.txt', { ownerId: users.admin.id });
    const adminsOnB = await shareOn('Projects/b.txt', { ownerId: users.admin.id });
    const a = (await deleteAs('alice', 'Projects', 'a.txt')).body.items[0].trashItemId;
    const b = (await deleteAs('alice', 'Projects', 'b.txt')).body.items[0].trashItemId;

    const byAlice = await as('alice').post('/api/trash/restore-to', {
      ids: [a],
      destination: 'Archive',
      shares: 'restore',
    });
    const byAdmin = await as('admin').post('/api/trash/restore-to', {
      ids: [b],
      destination: 'Archive',
      shares: 'restore',
    });

    expect(doneOf(byAlice).items[0]).toMatchObject({ sharesRestored: 1, sharesDropped: 1 });
    expect((await shares.getShareById(alicesOnA.id)).sourcePath).toBe('Archive/a.txt');
    expect(await shares.getShareById(adminsOnA.id)).toBeNull();
    expect(doneOf(byAdmin).items[0]).toMatchObject({ sharesRestored: 1, sharesDropped: 0 });
    expect((await shares.getShareById(adminsOnB.id)).sourcePath).toBe('Archive/b.txt');
  });

  it('brings back the people a share was for', async () => {
    await write('Projects/report.txt');
    const share = await shareOn('Projects/report.txt', {
      sharingType: 'users',
      userIds: [users.bob.id],
    });
    const { trashItemId: id } = (await deleteAs('alice', 'Projects', 'report.txt')).body.items[0];

    await restore('alice', { ids: [id], shares: 'restore' });

    expect((await shares.getShareById(share.id)).permittedUserIds).toEqual([users.bob.id]);
  });

  it('lets go of a share that expired in the trash, or whose owner is gone', async () => {
    await write('Projects/a.txt');
    await write('Projects/b.txt');
    const expiring = await shareOn('Projects/a.txt', {
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    const orphaned = await shareOn('Projects/b.txt', { ownerId: users.bob.id });
    const a = (await deleteAs('alice', 'Projects', 'a.txt')).body.items[0].trashItemId;
    const b = (await deleteAs('alice', 'Projects', 'b.txt')).body.items[0].trashItemId;
    vi.spyOn(load('src/services/trash/clock'), 'now').mockReturnValue(Date.now() + 2 * DAY);
    db.prepare('DELETE FROM users WHERE id = ?').run(users.bob.id);

    const response = await restore('alice', { ids: [a, b], shares: 'restore' });

    expect(
      response.body.items.map((result) => [result.sharesRestored, result.sharesDropped])
    ).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(await shares.getShareById(expiring.id)).toBeNull();
    expect(await shares.getShareById(orphaned.id)).toBeNull();
  });

  it('brings back the share of a personal file in its own space', async () => {
    const { resolvePersonalPath } = load('src/utils/pathUtils');
    const personalFile = await resolvePersonalPath('notes/today.txt', users.alice);
    await fs.mkdir(path.dirname(personalFile), { recursive: true });
    await fs.writeFile(personalFile, 'dear diary');
    const share = await shareOn('notes/today.txt', { sourceSpace: 'personal' });
    const { trashItemId: id } = (await deleteAs('alice', 'personal/notes', 'today.txt')).body
      .items[0];

    expect(kept()).toEqual([{ share_id: share.id, item_id: id, relative_path: '' }]);
    await restore('alice', { ids: [id], shares: 'restore' });

    expect(await shares.getShareById(share.id)).toMatchObject({
      sourceSpace: 'personal',
      sourcePath: 'notes/today.txt',
    });
  });

  it('refuses a choice for the share links it does not know', async () => {
    const { trashItemId: id } = await trashFile('Projects/report.txt');

    expect((await restore('alice', { ids: [id], shares: 'maybe' })).status).toBe(400);
  });
});

describe('a personal folder', () => {
  it('has its own trash, which its owner sees and restores from', async () => {
    const { resolvePersonalPath } = load('src/utils/pathUtils');
    const personalFile = await resolvePersonalPath('notes/today.txt', users.alice);
    await fs.mkdir(path.dirname(personalFile), { recursive: true });
    await fs.writeFile(personalFile, 'dear diary');

    const deleted = await deleteAs('alice', 'personal/notes', 'today.txt');
    expect(deleted.body.items[0].status).toBe('trashed');
    const personalRoot = path.dirname(path.dirname(personalFile));
    expect(await exists(path.join(personalRoot, '.nextexplorer', 'zone.json'))).toBe(true);

    const listed = await as('alice').get('/api/trash');
    expect(listed.body.items[0]).toMatchObject({
      location: { kind: 'personal', parent: 'notes' },
      openPath: 'personal/notes',
    });

    await as('alice').post('/api/trash/restore', { ids: [listed.body.items[0].id] });
    expect(await fs.readFile(personalFile, 'utf8')).toBe('dear diary');
  });
});

describe('a share link', () => {
  it('sends what a visitor deletes to the owner’s trash, not to theirs', async () => {
    await write('Projects/shared/doc.txt', 'shared content');
    const shares = load('src/services/sharesService');
    const share = await shares.createShare({
      ownerId: users.alice.id,
      sourceSpace: 'volume',
      sourcePath: 'Projects/shared',
      isDirectory: true,
      accessMode: 'readwrite',
      allowDelete: true,
    });

    const response = await deleteAs(`guest:${share.id}`, `share/${share.shareToken}`, 'doc.txt');

    expect(response.status).toBe(200);
    expect(response.body.items[0].status).toBe('trashed');
    const listed = await as('alice').get('/api/trash');
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      name: 'doc.txt',
      deletedBy: { id: null, label: 'share-link', isYou: false },
    });
    expect((await as('bob').get('/api/trash')).body.items).toEqual([]);

    await as('alice').post('/api/trash/restore', { ids: [listed.body.items[0].id] });
    expect(await fs.readFile(volume('Projects/shared/doc.txt'), 'utf8')).toBe('shared content');
  });
});

describe('deleting for good from the trash', () => {
  it('removes the item and its content', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    const id = deleted.body.items[0].trashItemId;

    const response = await as('alice').post('/api/trash/delete', { ids: [id] });

    expect(response.body.items).toEqual([
      { id, status: 'purged', reason: null, name: 'report.txt' },
    ]);
    expect(store.listItems(db)).toEqual([]);
    const trashDirectory = volume('Projects', '.nextexplorer', 'trash');
    expect(await fs.readdir(trashDirectory)).toEqual([]);
  });

  it('is not possible for someone else’s item', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    const id = deleted.body.items[0].trashItemId;

    const response = await as('bob').post('/api/trash/delete', { ids: [id] });

    expect(response.body.items).toEqual([{ id, status: 'not-found' }]);
    expect(store.listItems(db)).toHaveLength(1);
  });

  it('empties only what the person can see', async () => {
    await write('Projects/a1.txt');
    await write('Projects/a2.txt');
    await write('Projects/b.txt');
    await deleteAs('alice', 'Projects', 'a1.txt');
    await deleteAs('alice', 'Projects', 'a2.txt');
    await deleteAs('bob', 'Projects', 'b.txt');

    const response = await as('alice').post('/api/trash/empty', {});

    expect(response.body).toEqual({ purged: 2, unavailable: 0, failed: 0 });
    expect(store.listItems(db).map((item) => item.name)).toEqual(['b.txt']);
  });

  it('lets an administrator forget the items of a zone that is gone, and only then', async () => {
    await write('Projects/report.txt');
    const deleted = await deleteAs('alice', 'Projects', 'report.txt');
    const id = deleted.body.items[0].trashItemId;
    await fs.rm(volume('Projects', '.nextexplorer'), { recursive: true });

    const plain = await as('admin').post('/api/trash/delete', { ids: [id] });
    expect(plain.body.items[0]).toMatchObject({ status: 'unavailable', reason: 'missing' });

    const byAlice = await as('alice').post('/api/trash/delete', {
      ids: [id],
      forgetUnavailable: true,
    });
    expect(byAlice.body.items[0].status).toBe('unavailable');

    const forgotten = await as('admin').post('/api/trash/delete', {
      ids: [id],
      forgetUnavailable: true,
    });
    expect(forgotten.body.items[0].status).toBe('forgotten');
    expect(store.listItems(db)).toEqual([]);
  });
});

describe('administration', () => {
  it('shows every zone to an administrator, and to nobody else', async () => {
    await write('Projects/report.txt', '12345');
    await deleteAs('alice', 'Projects', 'report.txt');

    const forbidden = await as('alice').get('/api/trash/zones');
    const overview = await as('admin').get('/api/trash/zones');

    expect(forbidden.status).toBe(403);
    expect(overview.status).toBe(200);
    expect(overview.body.zones).toHaveLength(1);
    expect(overview.body.zones[0]).toMatchObject({
      kind: 'volume',
      name: 'Projects',
      available: true,
      itemCount: 1,
      usedBytes: 5,
    });
  });

  it('verifies every zone on request, for an administrator only', async () => {
    await write('Projects/report.txt');
    await deleteAs('alice', 'Projects', 'report.txt');

    expect((await as('alice').post('/api/trash/verify', {})).status).toBe(403);
    const response = await as('admin').post('/api/trash/verify', {});

    expect(response.body.zones).toEqual([
      expect.objectContaining({ name: 'Projects', available: true, violations: [] }),
    ]);
  });

  it('runs the maintenance on request, for an administrator only', async () => {
    expect((await as('alice').post('/api/trash/maintenance', {})).status).toBe(403);
    expect((await as('admin').post('/api/trash/maintenance', {})).status).toBe(200);
  });
});
