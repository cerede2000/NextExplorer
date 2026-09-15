import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Opening the editor from the Markdown preview downloaded the whole file a
 * second time: both asked for it with a POST, and a POST is never kept. A GET
 * is kept by the browser and asked again with the ETag it came with, and a file
 * that has not changed is answered 304 from its metadata alone.
 *
 * What must never happen is the other way round: a 304 for a file that did
 * change, or for someone who may no longer read it.
 */

let envContext;
let users;
let app;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const buildApp = () => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who) req.user = users[who];
    next();
  });
  application.use('/api', load('src/routes/editor'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

const FILE = 'Projects/notes.md';
const ORIGINAL = '# Notes\n\nThe first version of these notes.\n';

const open = (who, filePath = FILE, headers = {}) =>
  request(app)
    .get(`/api/editor?path=${encodeURIComponent(filePath)}`)
    .set('x-test-user', who)
    .set(headers);

const revalidate = (who, etag, filePath = FILE) => open(who, filePath, { 'If-None-Match': etag });

const save = (who, content, filePath = FILE) =>
  request(app).put('/api/editor').set('x-test-user', who).send({ path: filePath, content });

const setRules = (rules) =>
  load('src/services/settingsService').setSystemSetting('system', 'access', { rules });

/**
 * Filesystems keep times at the granularity of their clock tick — a few
 * milliseconds on Linux — so two changes inside one tick can carry the same
 * time. The changes below are spaced past that.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Overwrite bytes of the file where it is: same inode, same size. */
const rewriteInPlace = async (absolutePath, content) => {
  const handle = await fs.open(absolutePath, 'r+');
  try {
    await handle.write(content, 0, 'utf8');
  } finally {
    await handle.close();
  }
};

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'editor-caching-' });
  const usersService = load('src/services/users');
  users = {
    alice: await usersService.createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'secret123',
      roles: ['user'],
    }),
  };
  app = buildApp();
  await fs.mkdir(volume('Projects'), { recursive: true });
  await fs.writeFile(volume(FILE), ORIGINAL);
});

afterEach(async () => {
  vi.restoreAllMocks();
  load('src/services/trash/maintenance').stop?.();
  await envContext.cleanup();
});

describe('reading a file with a GET', () => {
  it('answers exactly what the POST answers', async () => {
    const byGet = await open('alice');
    const byPost = await request(app)
      .post('/api/editor')
      .set('x-test-user', 'alice')
      .send({ path: FILE });

    expect(byGet.status).toBe(200);
    expect(byGet.body).toEqual({ content: ORIGINAL });
    expect(byGet.text).toBe(byPost.text);
    expect(byGet.headers['content-type']).toBe(byPost.headers['content-type']);
  });

  it('is kept by the browser but checked every time, under an identity that holds still', async () => {
    const first = await open('alice');
    const second = await open('alice');

    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.etag).toMatch(/^W\/".+"$/);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('answers 304 to that identity without reading the file', async () => {
    const { etag } = (await open('alice')).headers;
    const readFile = vi.spyOn(fs, 'readFile');

    const response = await revalidate('alice', etag);
    const inAList = await revalidate('alice', `"something-else", ${etag}`);

    expect(response.status).toBe(304);
    expect(response.text).toBeFalsy();
    expect(response.headers.etag).toBe(etag);
    expect(response.headers.vary).toMatch(/accept-encoding/i);
    expect(inAList.status).toBe(304);
    const readsOfTheFile = readFile.mock.calls.filter(
      ([target]) => String(target) === volume(FILE)
    );
    expect(readsOfTheFile).toEqual([]);
  });

  it('answers the raw text 304 the same way', async () => {
    const target = `/api/raw?path=${encodeURIComponent(FILE)}`;
    const first = await request(app).get(target).set('x-test-user', 'alice');

    const again = await request(app)
      .get(target)
      .set('x-test-user', 'alice')
      .set('If-None-Match', first.headers.etag);

    expect(first.status).toBe(200);
    expect(first.text).toBe(ORIGINAL);
    expect(again.status).toBe(304);
  });
});

describe('a file that changed is read again', () => {
  it('after a save through the editor, whose answer carries the new identity', async () => {
    const { etag } = (await open('alice')).headers;
    // The same length, so neither the size nor the content length tells them apart.
    const rewritten = ORIGINAL.replace('first', 'final');
    await tick();

    const saved = await save('alice', rewritten);
    const response = await revalidate('alice', etag);

    expect(saved.status).toBe(200);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ content: rewritten });
    expect(response.headers.etag).not.toBe(etag);
    expect(saved.headers.etag).toBe(response.headers.etag);
    expect((await revalidate('alice', saved.headers.etag)).status).toBe(304);
  });

  it('after another file is renamed over it, with the same size and times', async () => {
    const when = new Date('2026-01-02T03:04:05Z');
    await fs.utimes(volume(FILE), when, when);
    const { etag } = (await open('alice')).headers;
    const replacement = ORIGINAL.replace('first', 'other');
    await fs.writeFile(volume('Projects/incoming.md'), replacement);
    await fs.utimes(volume('Projects/incoming.md'), when, when);
    await tick();

    await fs.rename(volume('Projects/incoming.md'), volume(FILE));
    const response = await revalidate('alice', etag);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ content: replacement });
  });

  it('after a write in place of the same length, at a different time', async () => {
    const { etag } = (await open('alice')).headers;
    const rewritten = ORIGINAL.replace('first', 'fixed');
    await tick();

    await rewriteInPlace(volume(FILE), rewritten);
    const response = await revalidate('alice', etag);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ content: rewritten });
  });

  it('after an append', async () => {
    const { etag } = (await open('alice')).headers;
    await tick();

    await fs.appendFile(volume(FILE), 'One more line.\n');
    const response = await revalidate('alice', etag);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ content: `${ORIGINAL}One more line.\n` });
  });

  /**
   * `cp -p`, `rsync --inplace -t` and an archive extracted over the file all
   * write in place and put the modification time back. Nothing can put back the
   * change time.
   */
  it('after a write in place that put the modification time back', async () => {
    const when = new Date('2026-01-02T03:04:05Z');
    await fs.utimes(volume(FILE), when, when);
    const { etag } = (await open('alice')).headers;
    const rewritten = ORIGINAL.replace('first', 'fixed');
    await tick();

    await rewriteInPlace(volume(FILE), rewritten);
    await fs.utimes(volume(FILE), when, when);
    const response = await revalidate('alice', etag);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ content: rewritten });
  });
});

describe('what a 304 must never stand in for', () => {
  it('a refusal: someone who may no longer read the file is refused, whatever they hold', async () => {
    const { etag } = (await open('alice')).headers;
    await setRules([{ path: 'Projects', recursive: true, permissions: 'hidden' }]);

    const response = await revalidate('alice', etag);

    expect(response.status).toBe(403);
    expect(response.headers.etag).not.toBe(etag);
    expect(response.headers['cache-control']).not.toBe('private, no-cache');
  });

  /**
   * An answer carrying an ETag and `private` may be kept by the browser, error
   * or not, and revalidated like any other — a 304 would then keep the error.
   */
  it('an error: a file that cannot be opened is answered without an identity', async () => {
    await fs.writeFile(volume('Projects/photo.md'), Buffer.from([0, 159, 146, 150, 0, 0, 1, 2]));

    const response = await open('alice', 'Projects/photo.md');

    // Express still tags the JSON of the error with a hash of its own bytes;
    // what must be absent is the file's identity, and the permission to keep.
    expect(response.status).toBe(415);
    expect(response.headers.etag ?? '').not.toMatch(/-t\d+"$/);
    expect(response.headers['cache-control']).toBeUndefined();
  });
});
