import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import express from 'express';
import request from 'supertest';
import { TarArchive, ZipArchive } from 'archiver';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import { hasSevenZip, isoBuilder, buildIso } from '../helpers/media-tools.js';

/**
 * The same browsing, against a real 7-Zip and a real archive.
 *
 * The suite beside this one stands 7-Zip in, which proves what is made of a
 * listing and nothing about the listing itself: the shape of that output is
 * 7-Zip's to decide, and it is what every guard here is written against. So
 * this builds an archive, asks the real tool, and reads the answer through the
 * route — the whole chain, once.
 *
 * Skipped where 7-Zip is not installed. CI asks for it by name through
 * REQUIRE_MEDIA_TOOLS, so a skip there is a failure rather than a quiet gap.
 */

const sevenZip = await hasSevenZip();
const iso = sevenZip ? await isoBuilder() : false;

let currentEnv;

afterEach(async () => {
  try {
    await currentEnv?.requireFresh('src/services/archiveCacheService').stopArchiveCacheWork();
  } catch (_) {
    // Never loaded, which is as stopped as it gets.
  }
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/** A real zip, written by the same library the application writes zips with. */
const writeZip = (file, entries) =>
  new Promise((resolve, reject) => {
    const output = fss.createWriteStream(file);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) {
      if (entry.directory) archive.append(null, { name: `${entry.path}/`, type: 'directory' });
      else archive.append(entry.content ?? 'x', { name: entry.path });
    }
    archive.finalize();
  });

/** A real .tar.gz: gzip around a tar, which is two archives rather than one. */
const writeTarGz = (file, entries) =>
  new Promise((resolve, reject) => {
    const output = fss.createWriteStream(file);
    const archive = new TarArchive({ gzip: true });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content ?? 'x', { name: entry.path });
    archive.finalize();
  });

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

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'archive-real-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

describe.skipIf(!sevenZip)('browsing a real archive with the real 7-Zip', () => {
  it('reads the top level, then a folder inside it', async () => {
    const volume = await seed();
    await writeZip(path.join(volume, 'backup.zip'), [
      { path: 'notes.txt', content: 'twelve bytes' },
      { path: 'docs/report.txt', content: 'a report' },
      { path: 'docs/deep/inner.txt', content: 'deeper' },
      { path: 'photos', directory: true },
    ]);
    const app = buildApp();

    const top = await request(app).get('/api/archive/list').query({ path: 'backup.zip' });

    expect(top.status).toBe(200);
    expect(top.body.entries.map((entry) => entry.name)).toEqual(['docs', 'photos', 'notes.txt']);
    const notes = top.body.entries.find((entry) => entry.name === 'notes.txt');
    expect(notes).toMatchObject({ isDirectory: false, size: 12 });
    expect(notes.modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const inside = await request(app)
      .get('/api/archive/list')
      .query({ path: 'backup.zip', inside: 'docs' });

    expect(inside.status).toBe(200);
    expect(inside.body.entries.map((entry) => entry.name)).toEqual(['deep', 'report.txt']);
  });

  /**
   * Nothing is written to disk to answer: the whole point of this, and the
   * thing a later refactor would quietly lose.
   */
  it('leaves the folder holding the archive exactly as it was', async () => {
    const volume = await seed();
    await writeZip(path.join(volume, 'backup.zip'), [
      { path: 'docs/report.txt', content: 'a report' },
    ]);
    const before = await fs.readdir(volume);

    const response = await request(buildApp())
      .get('/api/archive/list')
      .query({ path: 'backup.zip', inside: 'docs' });

    expect(response.status).toBe(200);
    expect(await fs.readdir(volume)).toEqual(before);
  });

  /**
   * The read, against the real tool. Two things only a real 7-Zip can prove:
   * that `-so` writes the bytes rather than a file, and that a name holding a
   * character 7-Zip reads as a pattern comes back as one file rather than
   * every file it matches.
   */
  it('takes one file out, by its exact name', async () => {
    const volume = await seed();
    await writeZip(path.join(volume, 'backup.zip'), [
      { path: 'docs/report.txt', content: 'the report itself' },
      { path: 'docs/other.txt', content: 'not this one' },
    ]);

    const response = await request(buildApp())
      .get('/api/archive/entry')
      .query({ path: 'backup.zip', entry: 'docs/report.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('the report itself');
    expect(response.headers['content-disposition']).toContain('report.txt');
  });

  it('reads a name 7-Zip would otherwise take for a pattern', async () => {
    const volume = await seed();
    await writeZip(path.join(volume, 'backup.zip'), [
      { path: 'report*.txt', content: 'the literal one' },
      { path: 'report1.txt', content: 'not this' },
      { path: 'report2.txt', content: 'nor this' },
    ]);

    const response = await request(buildApp())
      .get('/api/archive/entry')
      .query({ path: 'backup.zip', entry: 'report*.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('the literal one');
  });

  it('writes nothing to disk to hand a file over', async () => {
    const volume = await seed();
    await writeZip(path.join(volume, 'backup.zip'), [
      { path: 'docs/report.txt', content: 'the report itself' },
    ]);
    const before = await fs.readdir(volume);

    await request(buildApp())
      .get('/api/archive/entry')
      .query({ path: 'backup.zip', entry: 'docs/report.txt' });

    expect(await fs.readdir(volume)).toEqual(before);
  });

  /**
   * The compound case, against the real tool. What the stand-in cannot prove is
   * the assumption the whole path rests on: that 7-Zip reports a .tar.gz as one
   * entry whose name ends in .tar. If that is ever untrue, this is where it
   * shows, rather than in somebody's backup.
   */
  it('goes inside a real .tar.gz, and keeps one copy of the tar', async () => {
    const volume = await seed();
    await writeTarGz(path.join(volume, 'backup.tar.gz'), [
      { path: 'docs/report.txt', content: 'a report' },
      { path: 'notes.txt', content: 'twelve bytes' },
    ]);
    const app = buildApp();

    const top = await request(app).get('/api/archive/list').query({ path: 'backup.tar.gz' });

    expect(top.status).toBe(200);
    expect(top.body.entries.map((entry) => entry.name)).toEqual(['docs', 'notes.txt']);

    const inside = await request(app)
      .get('/api/archive/list')
      .query({ path: 'backup.tar.gz', inside: 'docs' });

    expect(inside.body.entries.map((entry) => entry.name)).toEqual(['report.txt']);

    const entry = await request(app)
      .get('/api/archive/entry')
      .query({ path: 'backup.tar.gz', entry: 'docs/report.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(entry.body.toString()).toBe('a report');

    // One copy, in the cache directory, and nothing beside the archive.
    const cached = await fs.readdir(path.join(currentEnv.cacheDir, 'archives'));
    expect(cached.filter((name) => name.endsWith('.inner'))).toHaveLength(1);
    expect(await fs.readdir(volume)).toEqual(['backup.tar.gz']);
  });

  /**
   * The formats that are not zip.
   *
   * Everything offered here goes through the same two commands, so what this
   * checks is that assumption rather than each format's own business: a .7z
   * made solid, where reading one entry means decompressing the ones before
   * it; a plain .tar, which is a filesystem laid end to end; and an ISO, which
   * is a filesystem full stop and only looks like an archive because 7-Zip
   * makes it.
   */
  it.each([
    ['a solid .7z', 'backup.7z'],
    ['a plain .tar', 'backup.tar'],
  ])('reads %s the same way', async (_name, filename) => {
    const volume = await seed();
    const source = path.join(currentEnv.tmpRoot, 'source');
    await fs.mkdir(path.join(source, 'docs'), { recursive: true });
    await fs.writeFile(path.join(source, 'notes.txt'), 'twelve bytes');
    await fs.writeFile(path.join(source, 'docs', 'report.txt'), 'a report');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const archivePath = path.join(volume, filename);
    // Solid is 7-Zip's default for .7z, which is the case worth covering: the
    // entries share one compressed stream.
    await run('7z', ['a', '-y', archivePath, '.'], { cwd: source });

    const app = buildApp();
    const top = await request(app).get('/api/archive/list').query({ path: filename });

    expect(top.status).toBe(200);
    expect(top.body.entries.map((entry) => entry.name)).toEqual(['docs', 'notes.txt']);

    const entry = await request(app)
      .get('/api/archive/entry')
      .query({ path: filename, entry: 'docs/report.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(entry.body.toString()).toBe('a report');
  });

  it.skipIf(!iso)('reads an ISO, which is a filesystem rather than an archive', async () => {
    const volume = await seed();
    const source = path.join(currentEnv.tmpRoot, 'source');
    await fs.mkdir(path.join(source, 'docs'), { recursive: true });
    await fs.writeFile(path.join(source, 'notes.txt'), 'twelve bytes');
    await fs.writeFile(path.join(source, 'docs', 'report.txt'), 'a report');
    await buildIso(iso, source, path.join(volume, 'disc.iso'));

    const app = buildApp();
    const top = await request(app).get('/api/archive/list').query({ path: 'disc.iso' });

    expect(top.status).toBe(200);
    expect(top.body.entries.map((entry) => entry.name)).toEqual(['docs', 'notes.txt']);

    const inside = await request(app)
      .get('/api/archive/list')
      .query({ path: 'disc.iso', inside: 'docs' });

    expect(inside.body.entries.map((entry) => entry.name)).toEqual(['report.txt']);

    const entry = await request(app)
      .get('/api/archive/entry')
      .query({ path: 'disc.iso', entry: 'docs/report.txt' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(entry.body.toString()).toBe('a report');
  });

  it('refuses a file that is not an archive, whatever it is called', async () => {
    const volume = await seed();
    await fs.writeFile(path.join(volume, 'pretend.zip'), 'not a zip at all');

    const response = await request(buildApp())
      .get('/api/archive/list')
      .query({ path: 'pretend.zip' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('ARCHIVE_UNREADABLE');
  });
});
