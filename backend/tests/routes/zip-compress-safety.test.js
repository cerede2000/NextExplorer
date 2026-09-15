import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import AdmZip from 'adm-zip';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Compressing writes a new file into a folder somebody already keeps things
 * in. What it must never do is take anything with it: an archive that was
 * already there under the same name, a location outside the folder it was
 * asked to write into, or a half-written archive left behind when the work
 * fails and presented as if it were a real one.
 *
 * `zip-refusals` covers who may compress what; this covers what the operation
 * leaves on disk.
 */

let ctx;
const binDirs = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (ctx) await ctx.cleanup();
  ctx = null;
  await Promise.all(binDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const ADMIN = { id: 'admin-1', roles: ['admin'] };

const seed = async (env = {}) => {
  ctx = await setupTestEnv({ tag: 'zip-compress-safety-', env });
  const work = path.join(ctx.volumeDir, 'Work');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'one.txt'), 'one\n');
  await fs.writeFile(path.join(work, 'two.txt'), 'two\n');
  return work;
};

const buildApp = () => {
  const routes = ctx.requireFresh('src/routes/zip');
  const { errorHandler } = ctx.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = ADMIN;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const compress = (body) => request(buildApp()).post('/api/files/zip/compress').send(body);

const events = (response) =>
  String(response.text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

const reason = (response) => response.body?.error?.message || response.text;

const exists = (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

/**
 * A 7-Zip that fails half way: it answers the format probe, so the route takes
 * the path the image ships with, then writes the start of an archive and exits
 * with an error — the state a full disk, a killed process or an unreadable
 * source leaves behind.
 */
const installFailingSevenZip = async (dir) => {
  const binary = path.join(dir, 'failing-7z');
  await fs.writeFile(
    binary,
    `#!/bin/sh
case "$1" in
  i) echo "Formats: zip 7z tar"; exit 0 ;;
  a) printf 'PK partial archive' > "$5"; echo "ERROR: simulated failure" >&2; exit 2 ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
  return binary;
};

/** A 7-Zip whose `a` command runs `onAdd`, with the archive path in "$5". */
const installSevenZip = async (name, onAdd) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-7z-'));
  binDirs.push(dir);
  const binary = path.join(dir, name);
  await fs.writeFile(
    binary,
    `#!/bin/sh
case "$1" in
  i) echo "Formats: zip 7z tar"; exit 0 ;;
  a) ${onAdd} ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
  return binary;
};

/** No 7-Zip: the archive is written by the JavaScript writer, wherever the tests run. */
const WITHOUT_SEVEN_ZIP = { SEVEN_ZIP_PATH: '/nonexistent/nextexplorer-test/7z' };

const BOTH = [
  { name: 'one.txt', path: 'Work' },
  { name: 'two.txt', path: 'Work' },
];

const entriesOf = (zipPath) =>
  new AdmZip(zipPath)
    .getEntries()
    .map((entry) => entry.entryName)
    .sort();

const listing = async (dir) => (await fs.readdir(dir)).sort();

/**
 * Put something under `target` just before the first filesystem call that
 * would take that name — a rename, a link, an exclusive create, a mkdir —:
 * after the name was seen free, before anything is put there.
 */
const arriveBeforeTaking = (target, arrive) => {
  let arrived = false;
  const at = (method, targetOf) => {
    const original = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation(async (...args) => {
      if (!arrived && path.resolve(String(targetOf(args))) === path.resolve(target)) {
        arrived = true;
        await arrive();
      }
      return original(...args);
    });
  };
  at('rename', (args) => args[1]);
  at('link', (args) => args[1]);
  at('open', (args) => args[0]);
  at('mkdir', (args) => args[0]);
  return () => arrived;
};

const waitFor = async (condition, what) => {
  const deadline = Date.now() + 5000;
  // eslint-disable-next-line no-await-in-loop
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('an archive written next to existing files', () => {
  it('never replaces an archive already there under the same name', async () => {
    const work = await seed();
    await fs.writeFile(path.join(work, 'bundle.zip'), 'the archive someone already made');

    const response = await compress({
      items: [{ name: 'one.txt', path: 'Work' }],
      destination: 'Work',
      name: 'bundle',
    });

    expect(response.status).toBe(200);
    expect(events(response).at(-1)).toMatchObject({
      type: 'done',
      item: { name: 'bundle (1).zip' },
    });
    expect(await fs.readFile(path.join(work, 'bundle.zip'), 'utf8')).toBe(
      'the archive someone already made'
    );
    expect(await exists(path.join(work, 'bundle (1).zip'))).toBe(true);
  });

  /**
   * The name is the one part of the request that becomes a path without going
   * through the authorization service, so it is checked as a name: a separator
   * in it would put the archive wherever the client pointed, outside the
   * destination that was authorized and, here, outside the volume.
   */
  it('refuses a name that would put the archive somewhere else', async () => {
    await seed();

    const response = await compress({
      items: [{ name: 'one.txt', path: 'Work' }],
      destination: 'Work',
      name: '../../escaped',
    });

    expect(response.status).toBe(400);
    expect(reason(response)).toMatch(/path separators/i);
    expect(await exists(path.join(ctx.volumeDir, 'escaped.zip'))).toBe(false);
    expect(await exists(path.join(ctx.tmpRoot, 'escaped.zip'))).toBe(false);
  });

  /**
   * The progress shows the start event's name for as long as the compression
   * lasts. It was the name asked for, so an archive landing at "bundle
   * (1).zip" was announced as "bundle.zip" — the file it steps aside for.
   */
  it('announces the name the archive will take when the one asked for is held', async () => {
    const work = await seed(WITHOUT_SEVEN_ZIP);
    await fs.writeFile(path.join(work, 'bundle.zip'), 'the archive someone already made');

    const response = await compress({ items: BOTH, destination: 'Work', name: 'bundle' });

    const stream = events(response);
    expect(stream[0]).toMatchObject({ type: 'start', name: 'bundle (1).zip' });
    expect(stream.at(-1)).toMatchObject({ type: 'done', item: { name: 'bundle (1).zip' } });
  });
});

describe('an archive that fails while it is being written', () => {
  it('is removed, and the stream says why instead of reporting success', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'failing-7z-'));
    binDirs.push(binDir);
    const work = await seed({ SEVEN_ZIP_PATH: await installFailingSevenZip(binDir) });

    const response = await compress({
      items: [
        { name: 'one.txt', path: 'Work' },
        { name: 'two.txt', path: 'Work' },
      ],
      destination: 'Work',
      name: 'bundle',
    });

    expect(response.status).toBe(200);
    const stream = events(response);
    expect(stream[0]).toMatchObject({ type: 'start', name: 'bundle.zip' });
    expect(stream.at(-1)).toMatchObject({ type: 'error' });
    expect(stream.at(-1).message).toMatch(/exited with code 2/);
    expect(stream.some((event) => event.type === 'done')).toBe(false);

    const left = (await fs.readdir(work)).sort();
    expect(left).toEqual(['one.txt', 'two.txt']);
  });

  it('never removes a file that arrived under the name before it failed', async () => {
    const sevenZip = await installSevenZip(
      'failing-7z',
      `printf 'saved over SMB during the compression' > "$(dirname "$5")/bundle.zip"
    printf 'PK partial archive' > "$5"; echo "ERROR: simulated failure" >&2; exit 2`
    );
    const work = await seed({ SEVEN_ZIP_PATH: sevenZip });

    const response = await compress({ items: BOTH, destination: 'Work', name: 'bundle' });

    expect(events(response).at(-1)).toMatchObject({ type: 'error' });
    expect(await fs.readFile(path.join(work, 'bundle.zip'))).toEqual(
      Buffer.from('saved over SMB during the compression')
    );
    expect(await listing(work)).toEqual(['bundle.zip', 'one.txt', 'two.txt']);
  });

  it('leaves nothing behind, hidden or not, when it is cancelled half way', async () => {
    // Writes the start of the archive, then works until it is stopped.
    const sevenZip = await installSevenZip(
      'slow-7z',
      `printf 'PK partial archive' > "$5"; exec sleep 30`
    );
    const work = await seed({ SEVEN_ZIP_PATH: sevenZip });
    const journal = path.join(ctx.cacheDir, 'in-flight');
    const records = () =>
      fss.existsSync(journal) ? fss.readdirSync(journal).filter((n) => n.endsWith('.json')) : [];

    const server = await new Promise((resolve) => {
      const listening = buildApp().listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const client = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/api/files/zip/compress',
        headers: { 'content-type': 'application/json' },
      });
      client.on('error', () => {});
      client.end(JSON.stringify({ items: BOTH, destination: 'Work', name: 'bundle' }));

      await waitFor(
        async () =>
          (await fs.readdir(work)).some((name) => /^\.nextexplorer-zip-.+\.zip$/.test(name)),
        'the archive to be written under a hidden name'
      );
      client.destroy();
      await waitFor(
        async () => (await fs.readdir(work)).length === 2 && records().length === 0,
        'the cancelled compression to clean up'
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    expect(await listing(work)).toEqual(['one.txt', 'two.txt']);
    expect(records()).toEqual([]);
  });
});

/**
 * The name an archive is meant to take can be free when the compression starts
 * and taken before it ends — another compression, a copy, a file saved over
 * SMB. Whatever arrives under it stays exactly as it is, and the archive takes
 * the next name, which the stream reports.
 */
describe('an archive meeting a file that arrives under its name', () => {
  it('never overwrites a file that arrives once the archive is being written', async () => {
    const work = await seed(WITHOUT_SEVEN_ZIP);
    const target = path.join(work, 'bundle.zip');
    const theirs = Buffer.from('PK an archive someone copied in meanwhile');
    const createWriteStream = fss.createWriteStream;
    let arrived = false;
    vi.spyOn(fss, 'createWriteStream').mockImplementation((file, options) => {
      if (!arrived && path.dirname(String(file)) === work) {
        arrived = true;
        fss.writeFileSync(target, theirs);
      }
      return createWriteStream.call(fss, file, options);
    });

    const response = await compress({ items: BOTH, destination: 'Work', name: 'bundle' });

    expect(arrived).toBe(true);
    expect(events(response).at(-1)).toMatchObject({
      type: 'done',
      item: { name: 'bundle (1).zip' },
    });
    expect(await fs.readFile(target)).toEqual(theirs);
    expect(entriesOf(path.join(work, 'bundle (1).zip'))).toEqual(['one.txt', 'two.txt']);
    expect(await listing(work)).toEqual(['bundle (1).zip', 'bundle.zip', 'one.txt', 'two.txt']);
  });

  it('never replaces a file that takes the name just before the archive is put there', async () => {
    const work = await seed(WITHOUT_SEVEN_ZIP);
    const target = path.join(work, 'bundle.zip');
    const theirs = Buffer.from('saved over SMB at the last moment');
    const arrived = arriveBeforeTaking(target, () => fs.writeFile(target, theirs));

    const response = await compress({ items: BOTH, destination: 'Work', name: 'bundle' });

    expect(arrived()).toBe(true);
    expect(events(response).at(-1)).toMatchObject({
      type: 'done',
      item: { name: 'bundle (1).zip' },
    });
    expect(await fs.readFile(target)).toEqual(theirs);
    expect(entriesOf(path.join(work, 'bundle (1).zip'))).toEqual(['one.txt', 'two.txt']);
    expect(await listing(work)).toEqual(['bundle (1).zip', 'bundle.zip', 'one.txt', 'two.txt']);
  });

  it('never has 7-Zip add to a file that arrives, and gives 7-Zip a name ending in .zip', async () => {
    // 7-Zip appends ".zip" to an archive name without it, and adds to a zip it
    // finds rather than replacing it.
    const sevenZip = await installSevenZip(
      'arriving-7z',
      `case "$5" in *.zip) ;; *) echo "ERROR: would write $5.zip" >&2; exit 7 ;; esac
    printf 'saved over SMB during the compression' > "$(dirname "$5")/bundle.zip"
    printf 'PK archive written by 7-Zip' >> "$5"; exit 0`
    );
    const work = await seed({ SEVEN_ZIP_PATH: sevenZip });

    const response = await compress({ items: BOTH, destination: 'Work', name: 'bundle' });

    expect(events(response).at(-1)).toMatchObject({
      type: 'done',
      item: { name: 'bundle (1).zip' },
    });
    expect(await fs.readFile(path.join(work, 'bundle.zip'))).toEqual(
      Buffer.from('saved over SMB during the compression')
    );
    expect(await fs.readFile(path.join(work, 'bundle (1).zip'))).toEqual(
      Buffer.from('PK archive written by 7-Zip')
    );
    expect(await listing(work)).toEqual(['bundle (1).zip', 'bundle.zip', 'one.txt', 'two.txt']);
  });
});
