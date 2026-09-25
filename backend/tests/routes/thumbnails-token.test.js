import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The whole way a thumbnail is fetched, end to end.
 *
 * `/api/thumbnails` decides — it resolves the path, checks the access — and
 * then hands back a URL under `/static`, which the authentication middleware
 * does not cover. The decision has to travel with that URL, or the picture is
 * readable by anybody who can guess a file's path.
 *
 * So this walks it: ask the API, follow the URL it gives, and ask for the same
 * picture without what the API added.
 */

/** A real one-pixel PNG: the thumbnailer has to be able to read it. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const PICTURE = 'Pictures/dot.png';

let env;
let app;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'thumbnails-token-route-' });

  const alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  const absolute = path.join(env.volumeDir, ...PICTURE.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, ONE_PIXEL_PNG);

  app = express();
  app.use((req, _res, next) => {
    req.user = alice;
    req.session = {};
    next();
  });
  app.use('/api', load('src/routes/thumbnails'));
  load('src/utils/staticServer').configureStaticFiles(app);
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  await env.cleanup();
});

describe('asking for a thumbnail', () => {
  it('hands back a URL that opens, and only with what it handed back', async () => {
    const asked = await request(app).get(`/api/thumbnails/${PICTURE}`);

    expect(asked.status).toBe(200);
    const url = asked.body.thumbnail;
    expect(url, 'no thumbnail was made for a one-pixel PNG').toMatch(/^\/static\/thumbnails\//);
    expect(url).toContain('?t=');

    const [pathname, query] = url.split('?');
    expect((await request(app).get(pathname).query(query)).status).toBe(200);

    // The same picture, asked for without the proof the API attached: this is
    // every request that did not go through the access check.
    expect((await request(app).get(pathname)).status).toBe(401);
  });
});
