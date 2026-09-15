import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
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
});
