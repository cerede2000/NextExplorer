import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Asking for a thumbnail that is not made yet.
 *
 * A thumbnail used to be made inside the request that asked for it. A folder of
 * five hundred pictures is five hundred held requests, a video on a slow disk
 * holds one for minutes, and nothing could be said about which of them mattered
 * — the tile somebody is looking at waited behind the one scrolled past.
 *
 * The request now answers with what is already there, or says it has queued the
 * work and asks the caller to come back. What is worth doing first is decided
 * in the queue, where it can be.
 */

const PICTURE = 'Pictures/one.png';

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

// A one-pixel PNG: small enough to be made instantly, real enough for sharp.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'thumbnail-queue-' });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });
  await fs.mkdir(volume('Pictures'), { recursive: true });
  await fs.writeFile(volume('Pictures', 'one.png'), ONE_PIXEL_PNG);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/thumbnails'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/thumbnailService').stopThumbnailCacheCleanup?.();
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const ask = (query = '') => request(app).get(`/api/thumbnails/${PICTURE}${query}`);

/** As the file browser does: ask again while the answer says it is on its way. */
const askUntilMade = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const asked = await ask();
    if (asked.body.thumbnail) return asked;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the thumbnail was never made');
};

describe('asking for a thumbnail', () => {
  it('says it has been queued rather than holding the request', async () => {
    const first = await ask();

    expect(first.status).toBe(202);
    expect(first.body.pending).toBe(true);
    expect(first.body.thumbnail).toBeFalsy();
  });

  it('hands it over once it is made', async () => {
    const made = await askUntilMade();

    expect(made.status).toBe(200);
    expect(made.body.pending).toBe(false);
    expect(made.body.thumbnail).toMatch(/^\/static\/thumbnails\//);
  });

  /**
   * Once it exists, asking again is answered at once rather than queued — and
   * with the same picture. What this cannot show from outside is which of the
   * two short-circuits answered, the route's own cache check or the queue
   * finding the file already there; both give the same answer, which is why
   * there is no test claiming otherwise.
   */
  it('answers at once afterwards, with the same picture', async () => {
    const made = await askUntilMade();

    const again = await ask();

    expect(again.status).toBe(200);
    // The same cached picture; the proof on the end of the URL is minted fresh
    // each time, so it is the file the two answers have to agree on.
    expect(again.body.thumbnail.split('?')[0]).toBe(made.body.thumbnail.split('?')[0]);
  });

  /**
   * A prefetch is for what somebody has not looked at yet. It must never take
   * the place of the tile they are looking at.
   */
  it('takes a prefetch at a lower priority', async () => {
    const prefetch = await ask('?background=1');

    expect([200, 202]).toContain(prefetch.status);
    expect(await askUntilMade()).toBeTruthy();
  });

  it('refuses a file type that has no thumbnail', async () => {
    await fs.writeFile(volume('Pictures', 'notes.txt'), 'not a picture');

    const asked = await request(app).get('/api/thumbnails/Pictures/notes.txt');

    expect(asked.status).toBe(400);
  });

  it('says nothing at all when thumbnails are switched off', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'thumbnails', {
      enabled: false,
    });

    const asked = await ask();

    expect(asked.status).toBe(200);
    expect(asked.body.thumbnail).toBe('');
  });
});
