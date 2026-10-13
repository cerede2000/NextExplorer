import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The traversal guard is what refuses a climb, at every address that takes a path.
 *
 * These routes all end in a wildcard, and every one of them joins the segments
 * back together and hands the result to `normalizeRelativePath`, which throws on
 * a `..` segment. What is asserted here is that the guard is the thing that
 * answers — a 400 and not a 404 — and the distinction is the whole point.
 *
 * Four layers refuse a climb, and three of them refuse it for reasons that have
 * nothing to do with traversal: the logical path model resolves its first
 * segment as a volume name, and `..` is not a volume, so "not found"; then the
 * containment check compares real paths; then the access check. Standing all
 * three down leaves the climb answered 404 anyway. So a test that accepts any
 * refusal asserts nothing: it passes with the guard deleted, and it passes with
 * the containment check deleted, which was measured rather than assumed.
 *
 * Asserting the status the *guard* produces is what makes this live, and what
 * makes it worth having: the router decides what the segments are, and the
 * router is not ours. Express 5.2 collapsed `..` before the handler saw it, so
 * a climbing path arrived flattened and was refused further in; express 5.3
 * hands the segments through and the guard answers. That changed under us,
 * between two patch releases of a dependency, with nothing watching. This
 * watches, at every one of the seven addresses, in both of the spellings a
 * climb can arrive in.
 */

let env;
let app;

const load = (relative) => require(modulePath(relative));

/** The addresses that end in a wildcard, as `routes/index.js` mounts them. */
const WILDCARD_ADDRESSES = [
  ['get', '/api/metadata'],
  ['get', '/api/browse'],
  ['get', '/api/thumbnails'],
  ['get', '/api/folder-size'],
  ['post', '/api/folder-size/refresh'],
  ['get', '/api/permissions'],
  ['get', '/api/usage'],
];

/** What somebody climbing out of the volume would write. */
const CLIMBS = [
  '../../etc/passwd',
  '..%2f..%2fetc/passwd',
  'Docs/../../../etc/passwd',
  '%2e%2e/%2e%2e/etc/passwd',
];

const send = (method, address, suffix) => {
  const url = `${address}/${suffix}`;
  return method === 'post' ? request(app).post(url).send({}) : request(app).get(url);
};

beforeEach(async () => {
  // Folder sizes on, or that router answers 404 to everything and its rows in
  // the table below would prove nothing.
  env = await setupTestEnv({
    tag: 'wildcard-traversal-',
    env: { FOLDER_SIZE_MODE: 'shallow' },
  });
  const users = load('src/services/users');
  const alice = await users.createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['admin'],
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/browse'));
  app.use('/api', load('src/routes/thumbnails'));
  app.use('/api', load('src/routes/metadata'));
  app.use('/api', load('src/routes/folderSize'));
  app.use('/api', load('src/routes/permissions'));
  app.use('/api', load('src/routes/usage'));
  app.use(load('src/middleware/errorHandler').errorHandler);

  await fs.mkdir(path.join(env.volumeDir, 'Docs'), { recursive: true });
  await fs.writeFile(path.join(env.volumeDir, 'Docs', 'notes.txt'), 'here\n');
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

describe('a path that climbs out of the volume', () => {
  it('is refused by the guard, and not merely by what lies behind it', async () => {
    for (const [method, address] of WILDCARD_ADDRESSES) {
      for (const climb of CLIMBS) {
        const response = await send(method, address, climb);
        const where = `${method.toUpperCase()} ${address}/${climb}`;

        // 400, which is the guard's own refusal. A 404 here would mean the
        // segments reached the path model flattened or unexamined, and that the
        // climb is being refused by something that was not looking for one.
        expect(response.status, where).toBe(400);

        // And nothing of the filesystem in the answer, which is the other half
        // of refusing: a message naming where the volume lives would hand over
        // what the request was asking for.
        const said = JSON.stringify(response.body || '') + String(response.text || '');
        expect(said, where).not.toContain(env.volumeDir);
        expect(said, where).not.toContain('/etc/passwd');
      }
    }
  });

  // Without this the table above would pass on a server where every one of
  // those addresses is broken.
  it('while the same addresses answer an ordinary path', async () => {
    const browse = await request(app).get('/api/browse/Docs');
    expect(browse.status).toBe(200);
    expect(browse.body.items.map((item) => item.name)).toContain('notes.txt');

    const metadata = await request(app).get('/api/metadata/Docs/notes.txt');
    expect(metadata.status).toBe(200);

    const size = await request(app).get('/api/folder-size/Docs');
    expect(size.status).toBe(200);

    const permissions = await request(app).get('/api/permissions/Docs');
    expect(permissions.status).toBe(200);

    const usage = await request(app).get('/api/usage/Docs');
    expect(usage.status).toBe(200);
  });
});
