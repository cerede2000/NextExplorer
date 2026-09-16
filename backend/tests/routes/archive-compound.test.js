import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { useFakeSevenZip, fakeListing, fakeCompound } from '../helpers/fake-seven-zip.js';

/**
 * Looking inside a .tar.gz, which is two archives rather than one.
 *
 * 7-Zip peels one layer per run, so listing `backup.tar.gz` answers with a
 * single entry called `backup.tar` — true, and no use at all to somebody
 * looking for a file inside it. And a tar cannot be read from the middle: gzip
 * has no index, so reaching the last entry means decompressing everything
 * before it. Doing that per request would mean decompressing the whole backup
 * to list one folder, and again for the next click.
 *
 * So it is decompressed once, into the cache directory, and both the listing
 * and the reads go to that copy. What this pins is the once, the ceiling above
 * which it is not done at all, and that nothing is written where somebody's
 * files are.
 */

let currentEnv;
let restoreSevenZip;

afterEach(async () => {
  try {
    const cache = currentEnv?.requireFresh('src/services/archiveCacheService');
    await cache?.stopArchiveCacheWork();
  } catch (_) {
    // Never loaded, which is as stopped as it gets.
  }
  restoreSevenZip?.();
  restoreSevenZip = null;
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  restoreSevenZip = useFakeSevenZip();
  currentEnv = await setupTestEnv({ tag: 'archive-compound-', env });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

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

/** An archive that decompresses to another archive, as a .tar.gz does. */
const writeCompound = async (volume, name, options) => {
  const { outer, inner } = fakeCompound(options);
  const file = path.join(volume, name);
  await fs.writeFile(file, outer);
  await fs.writeFile(`${file}.inner`, inner);
  return file;
};

const list = (query) => request(buildApp()).get('/api/archive/list').query(query);

const cachedFiles = async () => {
  try {
    return (await fs.readdir(path.join(currentEnv.cacheDir, 'archives'))).sort();
  } catch (_) {
    return [];
  }
};

describe('a compound archive', () => {
  it('shows what is inside the tar, not the tar itself', async () => {
    const volume = await seed();
    await writeCompound(volume, 'backup.tar.gz', {
      entries: [
        { path: 'docs/report.txt', size: 8, content: 'a report' },
        { path: 'notes.txt', size: 12, content: 'twelve bytes' },
      ],
    });

    const response = await list({ path: 'backup.tar.gz' });

    expect(response.status).toBe(200);
    expect(response.body.entries.map((entry) => entry.name)).toEqual(['docs', 'notes.txt']);
  });

  it('goes down a level inside it', async () => {
    const volume = await seed();
    await writeCompound(volume, 'backup.tar.gz', {
      entries: [{ path: 'docs/report.txt', size: 8, content: 'a report' }],
    });

    const response = await list({ path: 'backup.tar.gz', inside: 'docs' });

    expect(response.status).toBe(200);
    expect(response.body.entries.map((entry) => entry.name)).toEqual(['report.txt']);
  });

  it('reads one file out of it', async () => {
    const volume = await seed();
    await writeCompound(volume, 'backup.tar.gz', {
      entries: [{ path: 'docs/report.txt', size: 8, content: 'a report' }],
    });

    const response = await request(buildApp())
      .get('/api/archive/entry')
      .query({ path: 'backup.tar.gz', entry: 'docs/report.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('a report');
  });

  /** Decompressed once: the second look reads the copy the first one made. */
  it('keeps one copy, and uses it again', async () => {
    const volume = await seed();
    const file = await writeCompound(volume, 'backup.tar.gz', {
      entries: [{ path: 'notes.txt', size: 12, content: 'twelve bytes' }],
    });

    await list({ path: 'backup.tar.gz' });
    const afterFirst = await cachedFiles();
    // Taking the source away proves the second listing did not go back to it.
    await fs.rm(`${file}.inner`);

    const second = await list({ path: 'backup.tar.gz' });

    expect(afterFirst).toHaveLength(1);
    expect(await cachedFiles()).toEqual(afterFirst);
    expect(second.status).toBe(200);
    expect(second.body.entries.map((entry) => entry.name)).toEqual(['notes.txt']);
  });

  /** Nowhere near the volume: a file there would be listed, indexed and backed up. */
  it('writes its copy under the cache directory and nowhere else', async () => {
    const volume = await seed();
    await writeCompound(volume, 'backup.tar.gz', {
      entries: [{ path: 'notes.txt', size: 12, content: 'twelve bytes' }],
    });
    const before = (await fs.readdir(volume)).sort();

    await list({ path: 'backup.tar.gz' });

    expect((await fs.readdir(volume)).sort()).toEqual(before);
    expect(await cachedFiles()).toHaveLength(1);
  });

  /**
   * The refusal comes before anything is written: the size is what the outer
   * archive already declares, so it costs a listing rather than a disk.
   */
  it('refuses to open one too large to hold, and writes nothing', async () => {
    const volume = await seed({ MAX_BROWSABLE_ARCHIVE_SIZE: '1K' });
    await writeCompound(volume, 'huge.tar.gz', {
      innerSize: 4096,
      entries: [{ path: 'notes.txt', size: 12, content: 'twelve bytes' }],
    });

    const response = await list({ path: 'huge.tar.gz' });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ARCHIVE_TOO_LARGE_TO_BROWSE');
    expect(await cachedFiles()).toEqual([]);
  });

  /**
   * A gzipped text file is one entry too, and it is not an archive to go
   * inside: it is a file to hand over, which the listing already offers.
   */
  it('leaves a gzipped file as the one file it is', async () => {
    const volume = await seed();
    await fs.writeFile(
      path.join(volume, 'notes.txt.gz'),
      fakeListing([{ path: 'notes.txt', size: 12, content: 'twelve bytes' }])
    );

    const response = await list({ path: 'notes.txt.gz' });

    expect(response.status).toBe(200);
    expect(response.body.entries.map((entry) => entry.name)).toEqual(['notes.txt']);
    expect(await cachedFiles()).toEqual([]);
  });

  /** An archive replaced by another of the same name is a different archive. */
  it('makes a new copy when the archive itself changes', async () => {
    const volume = await seed();
    const file = await writeCompound(volume, 'backup.tar.gz', {
      entries: [{ path: 'first.txt', size: 5, content: 'first' }],
    });
    await list({ path: 'backup.tar.gz' });

    const { outer, inner } = fakeCompound({
      entries: [{ path: 'second.txt', size: 6, content: 'second' }],
    });
    await fs.writeFile(file, `${outer}\n`);
    await fs.writeFile(`${file}.inner`, inner);
    await fs.utimes(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    const response = await list({ path: 'backup.tar.gz' });

    expect(response.body.entries.map((entry) => entry.name)).toEqual(['second.txt']);
    expect(await cachedFiles()).toHaveLength(2);
  });
});
