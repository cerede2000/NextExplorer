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
        { path: 'Projects/report.txt', disposition: 'trash', reason: null },
        { path: 'Projects/mount/other.txt', disposition: 'permanent', reason: 'other-device' },
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
      { path: 'Projects/report.txt', disposition: 'permanent', reason: 'disabled' },
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
