import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A file's history through the API, the way the Versions panel uses it: who
 * may see it, download from it, put a version back, take one out as a copy or
 * over another file, name and pin one, and delete them — from inside the
 * application and through a share, whose owner decides what it shows.
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

const read = (relative) => fs.readFile(volume(relative), 'utf8');

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
  application.use('/api', load('src/routes/editor'));
  application.use('/api', load('src/routes/versions'));
  application.use('/api/shares', load('src/routes/shares'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
  put: (url, body) => request(app).put(url).set('x-test-user', who).send(body),
  patch: (url, body) => request(app).patch(url).set('x-test-user', who).send(body),
});

const history = (who, filePath) =>
  as(who).get(`/api/versions?path=${encodeURIComponent(filePath)}`);

/** Save through the text editor, as `who`. */
const edit = async (who, filePath, content) => {
  const response = await as(who).put('/api/editor', { path: filePath, content });
  expect(response.status).toBe(200);
};

const setRules = (rules) =>
  load('src/services/settingsService').setSystemSetting('system', 'access', { rules });

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'versions-routes-', env: { SHARES_ENABLED: 'true' } });
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
  app = buildApp();
  await write('Projects/notes.md', '# From outside\n');
  await fs.mkdir(volume('Photos'), { recursive: true });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  vi.restoreAllMocks();
  await envContext.cleanup();
});

describe('the history of a file', () => {
  it('lists the versions newest first, with who wrote each, and what the file is now', async () => {
    await edit('alice', 'Projects/notes.md', '# Alice one\n');
    await edit('bob', 'Projects/notes.md', '# Bob two\n');

    const response = await history('alice', 'Projects/notes.md');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      file: {
        name: 'notes.md',
        path: 'Projects/notes.md',
        size: 10,
        author: { id: users.bob.id, label: 'Bob' },
        source: 'editor',
      },
      rights: { see: true, download: true, restore: true, remove: true },
      totalBytes: 12 + 15,
    });
    expect(response.body.versions).toMatchObject([
      {
        size: 12,
        author: { id: users.alice.id, label: 'Alice' },
        source: 'editor',
        available: true,
      },
      { size: 15, author: null, source: 'external', pinned: false, label: null },
    ]);
  });

  it('names authors as their accounts are called now', async () => {
    await edit('alice', 'Projects/notes.md', '# Alice\n');
    await edit('bob', 'Projects/notes.md', '# Bob\n');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
      'Alice Martin',
      users.alice.id
    );

    const response = await history('bob', 'Projects/notes.md');

    expect(response.body.versions[0].author).toEqual({ id: users.alice.id, label: 'Alice Martin' });
  });

  it('answers a file that has no history yet with none', async () => {
    const response = await history('alice', 'Projects/notes.md');

    expect(response.status).toBe(200);
    expect(response.body.versions).toEqual([]);
    expect(response.body.file.author).toBeNull();
  });

  it('refuses what is not a file it can show', async () => {
    expect((await history('alice', 'Projects')).status).toBe(400);
    expect((await history('alice', 'Projects/missing.md')).status).toBe(404);
    expect((await as('alice').get('/api/versions')).status).toBe(400);
  });

  it('shows nothing to someone who cannot read the file', async () => {
    await edit('alice', 'Projects/notes.md', '# Alice\n');
    await setRules([{ path: 'Projects', recursive: true, permissions: 'hidden' }]);

    expect((await history('bob', 'Projects/notes.md')).status).toBe(403);
    expect((await as('guest:nothing').get('/api/versions?path=Projects/notes.md')).status).toBe(
      403
    );
  });
});

describe('reading a version', () => {
  const firstVersion = async () => {
    await edit('alice', 'Projects/notes.md', '# Alice\n');
    return (await history('alice', 'Projects/notes.md')).body.versions[0];
  };

  it('downloads it under the file’s name with the version’s date', async () => {
    const version = await firstVersion();

    const response = await as('bob')
      .get(`/api/versions/${version.id}/content?path=Projects/notes.md`)
      .buffer(true)
      .parse((res, done) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('# From outside\n');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment;.*notes \(version \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.md/
    );
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('reads its text without writing anything', async () => {
    const version = await firstVersion();

    const response = await as('bob').get(`/api/versions/${version.id}/text?path=Projects/notes.md`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'notes.md', content: '# From outside\n' });
    expect(await read('Projects/notes.md')).toBe('# Alice\n');
  });

  it('never reaches a version through a file it does not belong to', async () => {
    const version = await firstVersion();
    // A file with a history of its own: the version must be refused for not
    // being one of its versions, not for the file having none.
    await write('Photos/other.md', 'other');
    await edit('alice', 'Photos/other.md', 'other, edited');

    const response = await as('alice').get(`/api/versions/${version.id}/text?path=Photos/other.md`);

    expect(response.status).toBe(404);
  });
});

describe('putting a version back', () => {
  const twoVersions = async () => {
    await edit('alice', 'Projects/notes.md', '# Alice\n');
    await edit('alice', 'Projects/notes.md', '# Alice again\n');
    return (await history('alice', 'Projects/notes.md')).body.versions;
  };

  it('restores the file as the version had it, keeping what it replaces as a version', async () => {
    const [, oldest] = await twoVersions();

    const response = await as('alice').post(`/api/versions/${oldest.id}/restore`, {
      path: 'Projects/notes.md',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'replaced', path: 'Projects/notes.md' });
    expect(await read('Projects/notes.md')).toBe('# From outside\n');
    const after = (await history('alice', 'Projects/notes.md')).body;
    expect(after.versions.map((version) => version.id)).toContain(oldest.id);
    expect(after.versions[0]).toMatchObject({ source: 'editor', size: 14 });
    expect(after.file).toMatchObject({ source: 'restore', author: { label: 'Alice' } });
    const file = db.prepare("SELECT restored_at FROM version_files WHERE state = 'live'").get();
    expect(file.restored_at).toEqual(expect.any(String));
  });

  it('refuses someone who may read the file but not change it', async () => {
    const [, oldest] = await twoVersions();
    await setRules([{ path: 'Projects', recursive: true, permissions: 'ro' }]);

    const listing = await history('bob', 'Projects/notes.md');
    expect(listing.body.rights).toEqual({
      see: true,
      download: true,
      restore: false,
      remove: false,
    });
    const response = await as('bob').post(`/api/versions/${oldest.id}/restore`, {
      path: 'Projects/notes.md',
    });

    expect(response.status).toBe(403);
    expect(await read('Projects/notes.md')).toBe('# Alice again\n');
  });

  it('takes a version out as a new file in a folder someone chose', async () => {
    const [, oldest] = await twoVersions();

    const named = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
      name: 'notes before.md',
    });
    const unnamed = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
    });
    const again = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
    });

    expect(named.body).toEqual({ path: 'Photos/notes before.md', name: 'notes before.md' });
    expect(await read('Photos/notes before.md')).toBe('# From outside\n');
    expect(unnamed.body.name).toMatch(/^notes \(version \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.md$/);
    expect(again.body.name).not.toBe(unnamed.body.name);
    expect(await read('Projects/notes.md')).toBe('# Alice again\n');
  });

  /**
   * A copy is a new file. One that arrives under its name while the version's
   * content is being written — a file saved over SMB, another copy — is someone
   * else's: it stays as it is, it does not become an earlier version of the
   * copy, and the copy takes the next name.
   */
  it('never replaces, nor keeps as its version, a file that arrives under the name meanwhile', async () => {
    const [, oldest] = await twoVersions();
    const target = volume('Photos', 'notes before.md');
    const theirs = Buffer.from('dropped over SMB while the copy was written\n');
    const copyFile = fs.copyFile.bind(fs);
    let arrived = false;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (!arrived && path.dirname(to) === volume('Photos')) {
        arrived = true;
        await fs.writeFile(target, theirs);
      }
      return copyFile(from, to, mode);
    });

    const response = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
      name: 'notes before.md',
    });

    expect(arrived).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      path: 'Photos/notes before (1).md',
      name: 'notes before (1).md',
    });
    expect(await fs.readFile(target)).toEqual(theirs);
    expect(await read('Photos/notes before (1).md')).toBe('# From outside\n');
    expect((await fs.readdir(volume('Photos'))).sort()).toEqual([
      'notes before (1).md',
      'notes before.md',
    ]);
    expect((await history('alice', 'Photos/notes before.md')).body.versions).toEqual([]);
    expect((await history('alice', 'Photos/notes before (1).md')).body.versions).toEqual([]);
  });

  it('refuses a copy into a folder that is not one, or a name that is not one', async () => {
    const [, oldest] = await twoVersions();

    const noFolder = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Projects/notes.md',
    });
    const badName = await as('alice').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
      name: '../escape.md',
    });

    expect(noFolder.status).toBe(400);
    expect(badName.status).toBe(400);
  });

  it('puts a version over another file, whose own content becomes its version', async () => {
    const [, oldest] = await twoVersions();
    await write('Photos/other.md', 'what other held');

    const response = await as('alice').post(`/api/versions/${oldest.id}/replace`, {
      path: 'Projects/notes.md',
      target: 'Photos/other.md',
    });

    expect(response.status).toBe(200);
    expect(await read('Photos/other.md')).toBe('# From outside\n');
    const other = (await history('alice', 'Photos/other.md')).body.versions;
    expect(other).toHaveLength(1);
    const text = await as('alice').get(`/api/versions/${other[0].id}/text?path=Photos/other.md`);
    expect(text.body.content).toBe('what other held');
  });

  it('refuses a copy into a folder where files cannot be created', async () => {
    const [, oldest] = await twoVersions();
    await setRules([{ path: 'Photos', recursive: true, permissions: 'ro' }]);

    const response = await as('bob').post(`/api/versions/${oldest.id}/copy`, {
      path: 'Projects/notes.md',
      destination: 'Photos',
    });

    expect(response.status).toBe(403);
    expect(await fs.readdir(volume('Photos'))).toEqual([]);
  });

  it('never puts a version over a file someone may not change', async () => {
    const [, oldest] = await twoVersions();
    await write('Photos/other.md', 'what other held');
    await setRules([{ path: 'Photos', recursive: true, permissions: 'ro' }]);

    const response = await as('bob').post(`/api/versions/${oldest.id}/replace`, {
      path: 'Projects/notes.md',
      target: 'Photos/other.md',
    });

    expect(response.status).toBe(403);
    expect(await read('Photos/other.md')).toBe('what other held');
  });

  it('never puts a version over a folder', async () => {
    const [, oldest] = await twoVersions();

    const response = await as('alice').post(`/api/versions/${oldest.id}/replace`, {
      path: 'Projects/notes.md',
      target: 'Photos',
    });

    expect(response.status).toBe(400);
  });
});

describe('naming, pinning and deleting versions', () => {
  const threeVersions = async () => {
    await edit('alice', 'Projects/notes.md', '# one\n');
    await edit('alice', 'Projects/notes.md', '# two\n');
    await edit('alice', 'Projects/notes.md', '# three\n');
    return (await history('alice', 'Projects/notes.md')).body.versions;
  };

  it('names and pins a version, and takes the name away again', async () => {
    const [version] = await threeVersions();

    const named = await as('alice').patch(`/api/versions/${version.id}`, {
      path: 'Projects/notes.md',
      label: '  Sent to the client  ',
      pinned: true,
    });
    expect(named.body).toMatchObject({ label: 'Sent to the client', pinned: true });

    const cleared = await as('alice').patch(`/api/versions/${version.id}`, {
      path: 'Projects/notes.md',
      label: '',
    });
    expect(cleared.body).toMatchObject({ label: null, pinned: true });
  });

  it('refuses a name that is too long, or a pin that is not true or false', async () => {
    const [version] = await threeVersions();

    const tooLong = await as('alice').patch(`/api/versions/${version.id}`, {
      path: 'Projects/notes.md',
      label: 'x'.repeat(201),
    });
    const notBoolean = await as('alice').patch(`/api/versions/${version.id}`, {
      path: 'Projects/notes.md',
      pinned: 'yes',
    });

    expect(tooLong.status).toBe(400);
    expect(notBoolean.status).toBe(400);
  });

  it('deletes the versions chosen, then all of them, leaving the file alone', async () => {
    const versions = await threeVersions();

    const some = await as('alice').post('/api/versions/delete', {
      path: 'Projects/notes.md',
      ids: [versions[0].id, versions[2].id, 'not-one-of-them'],
    });
    expect(some.body.deleted).toBe(2);
    expect(some.body.items).toContainEqual({ id: 'not-one-of-them', status: 'not-found' });
    expect((await history('alice', 'Projects/notes.md')).body.versions.map((v) => v.id)).toEqual([
      versions[1].id,
    ]);

    const all = await as('alice').post('/api/versions/delete', {
      path: 'Projects/notes.md',
      all: true,
    });
    expect(all.body.deleted).toBe(1);
    expect((await history('alice', 'Projects/notes.md')).body.versions).toEqual([]);
    expect(await read('Projects/notes.md')).toBe('# three\n');
  });

  it('never deletes a version of another file through this one', async () => {
    await threeVersions();
    await write('Photos/other.md', 'other one');
    await edit('alice', 'Photos/other.md', 'other two');
    const [otherVersion] = (await history('alice', 'Photos/other.md')).body.versions;

    const response = await as('alice').post('/api/versions/delete', {
      path: 'Projects/notes.md',
      ids: [otherVersion.id],
    });

    expect(response.body).toEqual({
      items: [{ id: otherVersion.id, status: 'not-found' }],
      deleted: 0,
    });
    expect((await history('alice', 'Photos/other.md')).body.versions).toHaveLength(1);
  });

  it('lets only whoever may delete the file delete its versions', async () => {
    const [version] = await threeVersions();
    await setRules([{ path: 'Projects', recursive: true, permissions: 'ro' }]);

    const response = await as('bob').post('/api/versions/delete', {
      path: 'Projects/notes.md',
      ids: [version.id],
    });

    expect(response.status).toBe(403);
    expect((await history('admin', 'Projects/notes.md')).body.versions).toHaveLength(3);
  });

  it('refuses a request that names nothing to delete', async () => {
    await threeVersions();

    const response = await as('alice').post('/api/versions/delete', { path: 'Projects/notes.md' });

    expect(response.status).toBe(400);
  });
});

describe('the history through a share', () => {
  const share = async (body) => {
    const response = await as('alice').post('/api/shares', {
      sourcePath: 'Projects/notes.md',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body;
  };

  const withHistory = async () => {
    await edit('alice', 'Projects/notes.md', '# Alice\n');
    return (await history('alice', 'Projects/notes.md')).body.versions[0];
  };

  it('shows none through a link for anyone until its owner turns it on', async () => {
    const version = await withHistory();
    const link = await share({ sharingType: 'anyone', accessMode: 'readwrite' });
    expect(link).toMatchObject({ versionsVisible: false, versionsDownload: false });
    const visitor = as(`guest:${link.id}`);
    const through = `share/${link.shareToken}`;

    expect((await visitor.get(`/api/versions?path=${through}`)).status).toBe(403);

    await as('alice').put(`/api/shares/${link.id}`, { versionsVisible: true });
    const listed = await visitor.get(`/api/versions?path=${through}`);
    expect(listed.status).toBe(200);
    expect(listed.body.rights).toEqual({ see: true, download: false, restore: true, remove: true });
    expect((await visitor.get(`/api/versions/${version.id}/content?path=${through}`)).status).toBe(
      403
    );

    await as('alice').put(`/api/shares/${link.id}`, { versionsDownload: true });
    expect((await visitor.get(`/api/versions/${version.id}/content?path=${through}`)).status).toBe(
      200
    );
  });

  it('shows the history to the accounts a share names, by default', async () => {
    await withHistory();
    const named = await share({ sharingType: 'users', userIds: [users.bob.id] });
    expect(named).toMatchObject({ versionsVisible: true, versionsDownload: true });

    const response = await history('bob', `share/${named.shareToken}`);

    expect(response.status).toBe(200);
    expect(response.body.versions).toHaveLength(1);
  });

  it('lets a visitor restore only through a share that lets them write', async () => {
    const version = await withHistory();
    const readOnly = await share({ sharingType: 'anyone', versionsVisible: true });
    const readWrite = await share({
      sharingType: 'anyone',
      accessMode: 'readwrite',
      versionsVisible: true,
    });

    const refused = await as(`guest:${readOnly.id}`).post(`/api/versions/${version.id}/restore`, {
      path: `share/${readOnly.shareToken}`,
    });
    const restored = await as(`guest:${readWrite.id}`).post(`/api/versions/${version.id}/restore`, {
      path: `share/${readWrite.shareToken}`,
    });

    expect(refused.status).toBe(403);
    expect(restored.status).toBe(200);
    expect(await read('Projects/notes.md')).toBe('# From outside\n');
    const [newest] = (await history('alice', 'Projects/notes.md')).body.versions;
    expect(newest.author).toEqual({ id: users.alice.id, label: 'Alice' });
    expect((await history('alice', 'Projects/notes.md')).body.file.author).toEqual({
      id: null,
      label: 'share-link',
    });
  });

  it('refuses share options that are not true or false', async () => {
    const response = await as('alice').post('/api/shares', {
      sourcePath: 'Projects/notes.md',
      versionsVisible: 'yes',
    });

    expect(response.status).toBe(400);
  });
});
