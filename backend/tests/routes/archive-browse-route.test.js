import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { useFakeSevenZip, fakeListing } from '../helpers/fake-seven-zip.js';

/**
 * Looking inside an archive over the API.
 *
 * The archive is addressed like any other file — resolved and authorized the
 * same way — and where the caller is looking inside it is a separate
 * parameter. What this pins is the boundary: who may look, at what, and that
 * nothing inside an archive is ever taken for a path on disk.
 *
 * What 7-Zip itself prints is stood in for; what is made of it is covered in
 * `services/archive-browse.test.js`, and against a real 7-Zip in
 * `archive-browse-real.test.js`.
 */

let currentEnv;
let restoreSevenZip;

afterEach(async () => {
  restoreSevenZip?.();
  restoreSevenZip = null;
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async ({ env = {}, rules = [] } = {}) => {
  restoreSevenZip = useFakeSevenZip();
  currentEnv = await setupTestEnv({ tag: 'archive-browse-', env });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  if (rules.length) {
    await currentEnv.requireFresh('src/services/accessControlService').setRules(rules);
  }
  return currentEnv.volumeDir;
};

const buildApp = (user = { id: 'u1', email: 'u@example.com', roles: ['admin'] }) => {
  const routes = currentEnv.requireFresh('src/routes/archive');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

/** An archive whose listing is the one given, written where 7-Zip will read it. */
const writeArchive = async (volume, name, entries) => {
  const file = path.join(volume, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof entries === 'string' ? entries : fakeListing(entries));
  return file;
};

const list = (query) => request(buildApp()).get('/api/archive/list').query(query);

const named = (response) => response.body.entries.map((entry) => entry.name);

describe('listing what is in an archive', () => {
  it('answers the top level, folders before files', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [
      { path: 'notes.txt', size: 12 },
      { path: 'docs/report.txt', size: 4096 },
      { path: 'photos', directory: true },
    ]);

    const response = await list({ path: 'pack.zip' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: 'pack.zip', name: 'pack.zip', inside: '' });
    expect(named(response)).toEqual(['docs', 'photos', 'notes.txt']);
    expect(response.body.entries[2]).toMatchObject({ size: 12, isDirectory: false });
  });

  it('goes down a level without showing what is below it', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [
      { path: 'docs/report.txt', size: 1 },
      { path: 'docs/deep/inner.txt', size: 2 },
      { path: 'elsewhere.txt', size: 3 },
    ]);

    const response = await list({ path: 'pack.zip', inside: 'docs' });

    expect(response.status).toBe(200);
    expect(response.body.inside).toBe('docs');
    expect(named(response)).toEqual(['deep', 'report.txt']);
  });

  it('says how many entries the archive holds in all', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [
      { path: 'a.txt', size: 1 },
      { path: 'b/c.txt', size: 2 },
      { path: 'b/d.txt', size: 3 },
    ]);

    const response = await list({ path: 'pack.zip' });

    expect(response.body.total).toBe(3);
  });

  /**
   * The names a crafted archive carries are counted rather than shown: the
   * panel can say so, and nothing in the answer claims a place for them.
   */
  it('leaves out what points outside the archive, and says how much', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [
      { path: '../../etc/passwd', size: 1 },
      { path: 'C:/Windows/notepad.exe', size: 2 },
      { path: 'safe.txt', size: 3 },
    ]);

    const response = await list({ path: 'pack.zip' });

    expect(named(response)).toEqual(['safe.txt']);
    expect(response.body.outside).toBe(2);
  });

  it('refuses a position that points outside the archive', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [{ path: 'docs/report.txt', size: 1 }]);

    const response = await list({ path: 'pack.zip', inside: '../../etc' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ARCHIVE_BAD_POSITION');
  });

  it('says a folder is not there rather than answering an empty one', async () => {
    const volume = await seed();
    await writeArchive(volume, 'pack.zip', [{ path: 'docs/report.txt', size: 1 }]);

    const response = await list({ path: 'pack.zip', inside: 'nowhere' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ARCHIVE_ENTRY_NOT_FOUND');
  });
});

describe('an archive that cannot be browsed', () => {
  it('says so when its table of contents is behind a password', async () => {
    const volume = await seed();
    await writeArchive(volume, 'secret.zip', 'FAKE-7Z-ENCRYPTED\n');

    const response = await list({ path: 'secret.zip' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ARCHIVE_ENCRYPTED');
  });

  it('says so when it is damaged', async () => {
    const volume = await seed();
    await writeArchive(volume, 'broken.zip', 'FAKE-7Z-BROKEN\n');

    const response = await list({ path: 'broken.zip' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ARCHIVE_UNREADABLE');
  });

  it('refuses to open a file that is not an archive at all', async () => {
    const volume = await seed();
    await fs.writeFile(path.join(volume, 'notes.txt'), 'not an archive');

    const response = await list({ path: 'notes.txt' });

    expect(response.status).toBe(400);
  });

  it('refuses a folder', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Docs.zip'), { recursive: true });

    const response = await list({ path: 'Docs.zip' });

    expect(response.status).toBe(400);
  });

  it('says not found for an archive that is not there', async () => {
    await seed();

    const response = await list({ path: 'absent.zip' });

    expect(response.status).toBe(404);
  });

  it('needs a path at all', async () => {
    await seed();

    const response = await list({});

    expect(response.status).toBe(400);
  });
});

describe('who may look inside an archive', () => {
  /**
   * The archive is read through the same resolution as any other file, so a
   * folder an administrator hid or made unreadable hides its archives too.
   * Without this, browsing would be a way to read what listing refuses.
   */
  it('refuses one in a folder the caller may not read', async () => {
    const volume = await seed({
      env: { USER_VOLUMES: 'true' },
      rules: [{ path: 'Private', permissions: 'hidden', recursive: true }],
    });
    await writeArchive(volume, 'Private/pack.zip', [{ path: 'a.txt', size: 1 }]);

    const routes = currentEnv.requireFresh('src/routes/archive');
    const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'restricted', roles: [] };
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);

    const response = await request(app)
      .get('/api/archive/list')
      .query({ path: 'Private/pack.zip' });

    expect([403, 404]).toContain(response.status);
  });

  it('refuses a path that climbs out of the volume', async () => {
    await seed();

    const response = await list({ path: '../../etc/passwd' });

    expect([400, 403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });
});
