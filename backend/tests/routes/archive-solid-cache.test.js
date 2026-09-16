import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';
import { useFakeSevenZip, fakeListing } from '../helpers/fake-seven-zip.js';

/**
 * Reading a solid archive more than once.
 *
 * A solid `.7z` compresses every file into one stream, so reaching the last
 * entry means decompressing the ones before it. Measured on a runner with a
 * real 7-Zip (`scripts/measure-solid-7z.mjs`), on fifty megabytes that
 * compress about two to one: the first entry takes 0.02 s, the last 1.37 s,
 * and extracting the whole archive 1.41 s — about what that one read costs.
 * Ten entries read one at a time take 6.95 s.
 *
 * So the rule this pins: leave the first read alone, and on the second extract
 * once and serve every read after it from disk. Anything else — a zip, an
 * archive too large to hold — reads from the archive as it always did.
 */

let currentEnv;
let restoreSevenZip;
let logFile;

afterEach(async () => {
  try {
    await currentEnv?.requireFresh('src/services/archiveCacheService').stopArchiveCacheWork();
  } catch (_) {
    // Never loaded, which is as stopped as it gets.
  }
  restoreSevenZip?.();
  restoreSevenZip = null;
  delete process.env.FAKE_7Z_LOG;
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  restoreSevenZip = useFakeSevenZip();
  logFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fake-7z-log-')), 'calls');
  process.env.FAKE_7Z_LOG = logFile;

  currentEnv = await setupTestEnv({ tag: 'archive-solid-', env });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

/**
 * One application, for the whole of a test.
 *
 * Built once rather than per request on purpose: how many times an archive has
 * been read is something a running server remembers, and rebuilding the module
 * graph between two reads would be a restart — which forgets, exactly as a
 * real restart does.
 */
const buildApp = () => {
  const routes = currentEnv.requireFresh('src/routes/archive');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const ENTRIES = [
  { path: 'first.txt', size: 5, content: 'first' },
  { path: 'docs/second.txt', size: 6, content: 'second' },
  { path: 'docs/third.txt', size: 5, content: 'third' },
];

const writeArchive = async (volume, name, { solid = true, entries = ENTRIES } = {}) => {
  const file = path.join(volume, name);
  await fs.writeFile(file, fakeListing(entries, { solid }));
  return file;
};

const read = async (app, archive, entry) => {
  const response = await request(app)
    .get('/api/archive/entry')
    .query({ path: archive, entry })
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  return response;
};

/** What 7-Zip was asked to do, one line per call. */
const calls = async () =>
  (await fs.readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);

const extractions = async () =>
  (await calls()).filter((line) => line.startsWith('x ') && line.includes(' -o'));

const cached = async () => {
  const directory = currentEnv.requireFresh('src/services/archiveCacheService').cacheDirectory();
  return (await fs.readdir(directory).catch(() => [])).sort();
};

describe('the second read of a solid archive', () => {
  it('leaves the first read alone', async () => {
    const volume = await seed();
    await writeArchive(volume, 'solid.7z');

    const app = buildApp();

    const response = await read(app, 'solid.7z', 'first.txt');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('first');
    expect(await extractions()).toHaveLength(0);
    expect(await cached()).toEqual([]);
  });

  it('extracts once, and answers the reads after it from disk', async () => {
    const volume = await seed();
    await writeArchive(volume, 'solid.7z');

    const app = buildApp();

    await read(app, 'solid.7z', 'first.txt');
    const second = await read(app, 'solid.7z', 'docs/second.txt');

    expect(second.body.toString()).toBe('second');
    expect(await extractions()).toHaveLength(1);
    expect((await cached()).filter((name) => name.endsWith('.tree'))).toHaveLength(1);

    const before = (await calls()).length;
    const third = await read(app, 'solid.7z', 'docs/third.txt');

    expect(third.body.toString()).toBe('third');
    // Nothing more was asked of 7-Zip: the listing is cached in neither
    // direction, so the only calls left are the ones that read the archive.
    expect((await calls()).filter((line) => line.startsWith('x '))).toHaveLength(2);
    expect((await calls()).length).toBeGreaterThan(before - 1);
  });

  /** A zip has a start for every entry: there is nothing to save. */
  it('never does it for an archive that is not solid', async () => {
    const volume = await seed();
    await writeArchive(volume, 'plain.zip', { solid: false });

    const app = buildApp();

    await read(app, 'plain.zip', 'first.txt');
    await read(app, 'plain.zip', 'docs/second.txt');
    const third = await read(app, 'plain.zip', 'docs/third.txt');

    expect(third.body.toString()).toBe('third');
    expect(await extractions()).toHaveLength(0);
    expect(await cached()).toEqual([]);
  });

  /**
   * The objection the measurement had to answer: extracting eight gigabytes
   * because somebody clicked one file is a worse trade than the slow read. The
   * ceiling is the one that already decides what may be browsed at all.
   */
  it('refuses to extract one larger than the ceiling, and reads it anyway', async () => {
    const volume = await seed({ MAX_BROWSABLE_ARCHIVE_SIZE: '8' });
    await writeArchive(volume, 'huge.7z');

    const app = buildApp();

    await read(app, 'huge.7z', 'first.txt');
    const second = await read(app, 'huge.7z', 'docs/second.txt');

    expect(second.status).toBe(200);
    expect(second.body.toString()).toBe('second');
    expect(await extractions()).toHaveLength(0);
  });

  /** One archive's reads are its own. */
  it('counts each archive separately', async () => {
    const volume = await seed();
    await writeArchive(volume, 'one.7z');
    await writeArchive(volume, 'two.7z');

    const app = buildApp();

    await read(app, 'one.7z', 'first.txt');
    await read(app, 'two.7z', 'first.txt');

    expect(await extractions()).toHaveLength(0);
  });
});

describe('a tree that is already there', () => {
  /**
   * The count of reads lives in memory, so a restart forgets it. What does not
   * go with it is the tree on disk: the first read after a restart is as free
   * as the tenth before it, or the extraction would be done again for nothing.
   */
  it('is used from the first read, however many this process has counted', async () => {
    const volume = await seed();
    await writeArchive(volume, 'solid.7z');

    const before = buildApp();
    await read(before, 'solid.7z', 'first.txt');
    await read(before, 'solid.7z', 'docs/second.txt');
    expect(await extractions()).toHaveLength(1);

    // A restart, and a real one: clearing the route alone would leave the
    // service — and the count it holds — exactly where it was.
    clearModuleCache('src/services/archiveBrowseService');
    const after = buildApp();
    const soFar = (await calls()).filter((line) => line.startsWith('x ')).length;
    const response = await read(after, 'solid.7z', 'docs/third.txt');

    expect(response.body.toString()).toBe('third');
    expect((await calls()).filter((line) => line.startsWith('x '))).toHaveLength(soFar);
  });
});

/**
 * The second lock on a door the listing already closed.
 *
 * A name that climbs out of the archive is dropped when the listing is read,
 * so nothing should ever reach this — which is exactly why it is worth a test
 * of its own: the day something does, joining it onto the tree's path would
 * read a file on the disk instead.
 */
describe('reading a name out of the tree', () => {
  it('refuses one that points outside it', async () => {
    await seed();
    const service = currentEnv.requireFresh('src/services/archiveBrowseService');
    const tree = path.join(currentEnv.tmpRoot, 'tree');
    await fs.mkdir(path.join(tree, 'inside'), { recursive: true });
    await fs.writeFile(path.join(tree, 'inside', 'ok.txt'), 'in');
    await fs.writeFile(path.join(currentEnv.tmpRoot, 'secret.txt'), 'out');

    expect(await service.openFromTree(tree, '../secret.txt')).toBeNull();
    expect(await service.openFromTree(tree, '/etc/hosts')).toBeNull();
    expect(await service.openFromTree(tree, 'inside/../../secret.txt')).toBeNull();

    const inside = await service.openFromTree(tree, 'inside/ok.txt');
    expect(inside).not.toBeNull();
    inside.stop();
  });
});
