import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';
import { hasSevenZip } from '../helpers/media-tools.js';

/**
 * Taking part of an archive out onto the volume.
 *
 * The other half of looking inside one: a folder of photographs in a backup is
 * found here and wanted *there*, and downloading it to put it back is not an
 * answer on a server somebody reaches from a phone.
 *
 * A real 7-Zip throughout, because what is being pinned is what lands on disk:
 * which entries came out, which did not, and what happens to the name when
 * something already holds it. A stand-in would only prove the arguments.
 */

const sevenZip = await hasSevenZip();

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'archive-extract-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

const buildApp = (user = { id: 'u1', roles: ['admin'] }) => {
  const routes = currentEnv.requireFresh('src/routes/archive');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

/** A real zip, built with 7-Zip itself so nothing here depends on a library. */
const writeArchive = async (volume, name, entries) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const source = path.join(currentEnv.tmpRoot, `source-${name}`);
  for (const entry of entries) {
    const file = path.join(source, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry.content ?? 'x');
  }
  await run('7z', ['a', '-y', path.join(volume, name), '.'], { cwd: source });
};

/** The events the extraction writes, read as the interface reads them. */
const extract = async (body) => {
  const response = await request(buildApp()).post('/api/archive/extract').send(body);
  const events = response.text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, events, done: events.find((event) => event.type === 'done') };
};

const tree = async (directory) => {
  const found = await fs.readdir(directory, { recursive: true });
  return found.map((entry) => entry.split(path.sep).join('/')).sort();
};

describe.skipIf(!sevenZip)('taking one entry out of an archive', () => {
  it('writes the file beside the archive, and nothing else', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [
      { path: 'notes.txt', content: 'twelve bytes' },
      { path: 'docs/report.txt', content: 'a report' },
      { path: 'docs/deep/inner.txt', content: 'deeper' },
    ]);

    const { done } = await extract({ path: 'backup.zip', entries: ['notes.txt'] });

    expect(done).toMatchObject({ success: true });
    expect(await tree(volume)).toEqual(['backup.zip', 'notes.txt']);
    expect(await fs.readFile(path.join(volume, 'notes.txt'), 'utf8')).toBe('twelve bytes');
  });

  it('takes a folder with everything under it', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [
      { path: 'notes.txt', content: 'twelve bytes' },
      { path: 'docs/report.txt', content: 'a report' },
      { path: 'docs/deep/inner.txt', content: 'deeper' },
    ]);

    const { done } = await extract({ path: 'backup.zip', entries: ['docs'] });

    expect(done.success).toBe(true);
    expect(await tree(volume)).toEqual([
      'backup.zip',
      'docs',
      'docs/deep',
      'docs/deep/inner.txt',
      'docs/report.txt',
    ]);
  });

  it('takes several at once', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [
      { path: 'one.txt', content: '1' },
      { path: 'two.txt', content: '2' },
      { path: 'three.txt', content: '3' },
    ]);

    const { done } = await extract({ path: 'backup.zip', entries: ['one.txt', 'three.txt'] });

    expect(done.items.map((item) => item.name).sort()).toEqual(['one.txt', 'three.txt']);
    expect(await tree(volume)).toEqual(['backup.zip', 'one.txt', 'three.txt']);
  });

  /**
   * The rule the whole application is held to: nothing is ever replaced. The
   * file that was there keeps its name and its contents, and what comes out of
   * the archive takes the next one.
   */
  it('never replaces a file that already holds the name', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'from the archive' }]);
    await fs.writeFile(path.join(volume, 'notes.txt'), 'the original');

    const { done } = await extract({ path: 'backup.zip', entries: ['notes.txt'] });

    expect(done.success).toBe(true);
    expect(await fs.readFile(path.join(volume, 'notes.txt'), 'utf8')).toBe('the original');
    expect(await fs.readFile(path.join(volume, 'notes (1).txt'), 'utf8')).toBe('from the archive');
  });

  it('leaves nothing hidden behind it', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);

    await extract({ path: 'backup.zip', entries: ['notes.txt'] });

    const hidden = (await fs.readdir(volume)).filter((name) => name.startsWith('.'));
    expect(hidden).toEqual([]);
  });

  it.each([
    ['a name that points outside the archive', ['../../etc/passwd']],
    ['a name the archive does not hold', ['invented.txt']],
    ['nothing at all', []],
  ])('refuses %s', async (_name, entries) => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);

    const response = await request(buildApp())
      .post('/api/archive/extract')
      .send({ path: 'backup.zip', entries });

    expect([400, 404]).toContain(response.status);
    expect(await tree(volume)).toEqual(['backup.zip']);
  });

  /**
   * Reading an archive is not the right to write beside it: a share that only
   * lets somebody look must not become a way to put files on the volume.
   */
  it('refuses a caller who may read the archive and not write in its folder', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'ReadOnly'), { recursive: true });
    await writeArchive(path.join(volume, 'ReadOnly'), 'backup.zip', [
      { path: 'notes.txt', content: 'twelve bytes' },
    ]);
    await currentEnv
      .requireFresh('src/services/accessControlService')
      .setRules([{ path: 'ReadOnly', permissions: 'ro', recursive: true }]);

    const routes = currentEnv.requireFresh('src/routes/archive');
    const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'reader', roles: [] };
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);

    const response = await request(app)
      .post('/api/archive/extract')
      .send({ path: 'ReadOnly/backup.zip', entries: ['notes.txt'] });

    expect(response.status).toBe(403);
    expect(await tree(path.join(volume, 'ReadOnly'))).toEqual(['backup.zip']);
  });
});

/**
 * Where it comes out.
 *
 * The folder the archive sits in is the answer when nobody says otherwise, and
 * it is the one the dialog offers first. A named destination changes where the
 * files land and nothing else: the same right to write is asked for, in the
 * same way, so pointing somewhere is never a way around what a read-only
 * folder means.
 */
describe.skipIf(!sevenZip)('choosing where it comes out', () => {
  it('puts what comes out in the folder that was asked for', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);
    await fs.mkdir(path.join(volume, 'Elsewhere'));

    const { done } = await extract({
      path: 'backup.zip',
      entries: ['notes.txt'],
      destination: 'Elsewhere',
    });

    expect(done).toMatchObject({ success: true });
    expect(await tree(volume)).toEqual(['Elsewhere', 'Elsewhere/notes.txt', 'backup.zip']);
    expect(done.items[0].path).toBe('Elsewhere');
  });

  it('falls back to the folder the archive is in, not to the root', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Backups'));
    await writeArchive(volume, path.join('Backups', 'backup.zip'), [
      { path: 'notes.txt', content: 'twelve bytes' },
    ]);

    const { done } = await extract({ path: 'Backups/backup.zip', entries: ['notes.txt'] });

    expect(done.success).toBe(true);
    expect(await tree(volume)).toEqual(['Backups', 'Backups/backup.zip', 'Backups/notes.txt']);
  });

  /**
   * Which layer refuses it is not the point: this route normalises the name and
   * the path layer under it refuses the same thing again. What is pinned is
   * that the answer is a refusal, before anything is written.
   */
  it('refuses a destination that climbs out of the volume', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);

    const { response } = await extract({
      path: 'backup.zip',
      entries: ['notes.txt'],
      destination: '../../etc',
    });

    expect(response.status).toBe(400);
    expect(await tree(volume)).toEqual(['backup.zip']);
  });

  /**
   * Said before the stream starts, rather than as a failed event halfway
   * through it: the first thing the extraction does is make a staging folder
   * inside the destination, and that error would arrive after "start".
   */
  it('refuses a destination that is not there, as an ordinary error', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);

    const { response, events } = await extract({
      path: 'backup.zip',
      entries: ['notes.txt'],
      destination: 'Nowhere',
    });

    expect(response.status).toBe(404);
    expect(events.some((event) => event.type === 'start')).toBe(false);
    expect(await tree(volume)).toEqual(['backup.zip']);
  });

  it('refuses a destination that is a file rather than a folder', async () => {
    const volume = await seed();
    await writeArchive(volume, 'backup.zip', [{ path: 'notes.txt', content: 'twelve bytes' }]);
    await fs.writeFile(path.join(volume, 'target.txt'), 'not a folder');

    const { response } = await extract({
      path: 'backup.zip',
      entries: ['notes.txt'],
      destination: 'target.txt',
    });

    expect(response.status).toBe(404);
    expect(await tree(volume)).toEqual(['backup.zip', 'target.txt']);
  });
});
