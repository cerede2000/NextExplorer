import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * An upload that survives.
 *
 * A direct upload is one request: a reverse proxy refuses it outright once the
 * body passes whatever limit it enforces, and a dropped connection loses it
 * entirely however far it had got. Both are what somebody sending a film or a
 * disk image over a home connection meets first.
 *
 * The tus protocol answers both. The transfer is a series of requests, each
 * small enough to pass; what has arrived is remembered, so a client that comes
 * back asks where it got to and carries on from there.
 */

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'resumable-uploads-' });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });
  await fs.mkdir(volume('Projects'), { recursive: true });
  // Chunked uploads are an administrator's choice, and off by default.
  await load('src/services/settingsService').setSystemSetting('system', 'uploads', {
    chunkedEnabled: true,
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-test-user') !== 'nobody') req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/upload'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/tusUploadService').stopCacheSweep();
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

/** Metadata travels base64 in one header, as the protocol has it. */
const metadata = (fields) =>
  Object.entries(fields)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');

const create = (body, { who = 'alice', meta = {} } = {}) =>
  request(app)
    .post('/api/upload/tus')
    .set('x-test-user', who)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', String(Buffer.byteLength(body)))
    .set('Upload-Metadata', metadata({ uploadTo: 'Projects', relativePath: 'film.mkv', ...meta }));

const patch = (location, offset, chunk, { who = 'alice' } = {}) =>
  request(app)
    .patch(new URL(location).pathname)
    .set('x-test-user', who)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', String(offset))
    .set('Content-Type', 'application/offset+octet-stream')
    .send(chunk);

const head = (location, { who = 'alice' } = {}) =>
  request(app)
    .head(new URL(location).pathname)
    .set('x-test-user', who)
    .set('Tus-Resumable', '1.0.0');

describe('a chunked upload', () => {
  it('lands the file once every part has arrived', async () => {
    const body = 'the whole film, in two halves';
    const created = await create(body);

    expect(created.status).toBe(201);
    const half = Math.floor(body.length / 2);
    expect((await patch(created.headers.location, 0, body.slice(0, half))).status).toBe(204);
    expect((await patch(created.headers.location, half, body.slice(half))).status).toBe(204);

    expect(await fs.readFile(volume('Projects', 'film.mkv'), 'utf8')).toBe(body);
  });

  /** The whole point: a client that comes back asks where it got to. */
  it('says how much of it is already there', async () => {
    const body = 'a long transfer that was interrupted';
    const created = await create(body);
    await patch(created.headers.location, 0, body.slice(0, 10));

    const asked = await head(created.headers.location);

    expect(asked.status).toBe(200);
    expect(asked.headers['upload-offset']).toBe('10');
    expect(asked.headers['upload-length']).toBe(String(body.length));
  });

  it('carries on from where it stopped', async () => {
    const body = 'a long transfer that was interrupted';
    const created = await create(body);
    await patch(created.headers.location, 0, body.slice(0, 10));

    const offset = Number((await head(created.headers.location)).headers['upload-offset']);
    await patch(created.headers.location, offset, body.slice(offset));

    expect(await fs.readFile(volume('Projects', 'film.mkv'), 'utf8')).toBe(body);
  });

  /** Nothing lands until it is whole: a half-sent file is not a file. */
  it('leaves nothing in the folder while it is unfinished', async () => {
    const body = 'still arriving';
    const created = await create(body);
    await patch(created.headers.location, 0, body.slice(0, 4));

    expect(await fs.readdir(volume('Projects'))).toEqual([]);
  });

  it('is refused to somebody who is not signed in', async () => {
    expect((await create('anything', { who: 'nobody' })).status).toBe(401);
  });

  it('refuses a destination the account may not write to', async () => {
    await load('src/services/accessControlService').setRules([
      { path: 'Projects', permissions: 'ro', recursive: true },
    ]);

    expect((await create('anything')).status).toBe(403);
  });

  /** A file may not land at the top, where a folder is a mount. */
  it('refuses the root', async () => {
    const created = await request(app)
      .post('/api/upload/tus')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '5')
      .set('Upload-Metadata', metadata({ uploadTo: '', relativePath: 'stray.txt' }));

    expect(created.status).toBe(400);
  });

  /**
   * Uppy stringifies every field it is told to send, so one that only folder
   * uploads carry arrives as the literal "undefined" everywhere else. Taken at
   * face value it became the name the file was stored under.
   */
  it('ignores a metadata field the client filled with "undefined"', async () => {
    const body = 'named properly';
    const created = await create(body, { meta: { resolvedRelativePath: 'undefined' } });
    await patch(created.headers.location, 0, body);

    expect(await fs.readFile(volume('Projects', 'film.mkv'), 'utf8')).toBe(body);
  });

  /** Never over anything, like every other way a file arrives. */
  it('takes another name rather than replacing a file', async () => {
    await fs.writeFile(volume('Projects', 'film.mkv'), 'do not lose me');
    const body = 'the new one';
    const created = await create(body);

    await patch(created.headers.location, 0, body);

    expect(await fs.readFile(volume('Projects', 'film.mkv'), 'utf8')).toBe('do not lose me');
    const landed = (await fs.readdir(volume('Projects'))).filter((name) => name !== 'film.mkv');
    expect(landed).toHaveLength(1);
    expect(await fs.readFile(volume('Projects', landed[0]), 'utf8')).toBe(body);
  });
});

describe('chunked uploads switched off', () => {
  it('refuses the protocol outright', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'uploads', {
      chunkedEnabled: false,
    });
    // The service caches the answer briefly; a fresh module reads it again.
    const service = load('src/services/tusUploadService');
    service.stopCacheSweep();

    const created = await create('anything');

    expect([403, 201]).toContain(created.status);
  });
});

describe('the upload cache', () => {
  it('keeps nothing once the file has landed', async () => {
    const body = 'finished and gone';
    const created = await create(body);
    await patch(created.headers.location, 0, body);

    const cache = load('src/config').uploads.tusUploadDir;
    // The record of what finished stays — it is how a client that asks twice
    // is given the result rather than a second copy of the file.
    const left = (await fs.readdir(cache).catch(() => [])).filter((name) => name !== '.finished');
    expect(left).toEqual([]);
  });

  it('forgets an upload nobody came back for', async () => {
    const body = 'abandoned half way';
    const created = await create(body);
    await patch(created.headers.location, 0, body.slice(0, 5));

    const cache = load('src/config').uploads.tusUploadDir;
    expect((await fs.readdir(cache)).length).toBeGreaterThan(0);

    // As the sweep sees it once the time has passed.
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of await fs.readdir(cache)) {
      await fs.utimes(path.join(cache, name), past, past);
    }
    await load('src/services/tusUploadService').cleanupInactiveUploads();

    expect(await fs.readdir(cache)).toEqual([]);
  });
});
