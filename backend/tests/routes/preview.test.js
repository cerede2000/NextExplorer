import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';

import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * /api/preview hands a file's bytes to the browser, inline, on the
 * application's own origin. Every image, film and PDF the explorer shows goes
 * through it, and nothing tested it: not who may read what, not the headers
 * that keep an SVG from running script, not the byte ranges a video player
 * seeks with.
 */

let ctx;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

// A hundred bytes whose values are their own offsets, so a range can be checked
// by content and not only by length.
const OFFSETS = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
const LEAK_MARKER = 'content-that-must-never-leave-the-disk-7f3a91';

const setup = async ({ user = { id: 'owner', roles: ['admin'] }, env = {} } = {}) => {
  ctx = await setupTestEnv({ tag: 'preview-route-', env });

  await fs.writeFile(path.join(ctx.volumeDir, 'photo.png'), OFFSETS);
  await fs.writeFile(path.join(ctx.volumeDir, 'film.mp4'), OFFSETS);
  await fs.writeFile(
    path.join(ctx.volumeDir, 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
  );
  await fs.writeFile(path.join(ctx.volumeDir, 'notes.txt'), 'plain text');
  await fs.writeFile(path.join(ctx.volumeDir, 'camera.nef'), 'not really a raw file');
  await fs.mkdir(path.join(ctx.volumeDir, 'Album'));

  const router = ctx.requireFresh('src/routes/files/preview');
  const { errorHandler } = ctx.requireFresh('src/middleware/errorHandler');
  return createTestApp({ router, mountPath: '/api', user, errorHandler });
};

const preview = (app, file) => request(app).get('/api/preview').query({ path: file });

/** supertest buffers images and video; anything else it may leave as text. */
const bytesOf = (response) =>
  Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '', 'binary');

describe('a file that can be previewed', () => {
  it('is sent whole, with its type and its length', async () => {
    const response = await preview(await setup(), 'photo.png').buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-length']).toBe('100');
    expect(bytesOf(response).equals(OFFSETS)).toBe(true);
  });

  it('tells the browser not to guess another type', async () => {
    const response = await preview(await setup(), 'photo.png');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

/**
 * An SVG opened on its own is a document, and a document runs its scripts —
 * on this origin, with this origin's session. The sandbox CSP stops that while
 * leaving an <img> free to draw it.
 */
describe('an SVG', () => {
  it('is sandboxed, so a script inside it cannot run on this origin', async () => {
    const response = await preview(await setup(), 'drawing.svg');

    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe('sandbox');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is the only kind sandboxed: an ordinary image is not', async () => {
    const response = await preview(await setup(), 'photo.png');

    expect(response.headers['content-security-policy']).toBeUndefined();
  });
});

describe('what cannot be previewed', () => {
  it('is refused without a path', async () => {
    const response = await request(await setup()).get('/api/preview');

    expect(response.status).toBe(400);
  });

  it('is refused for a directory', async () => {
    const response = await preview(await setup(), 'Album');

    expect(response.status).toBe(400);
  });

  it('is refused for a type the viewer has no use for, as unsupported', async () => {
    const response = await preview(await setup(), 'notes.txt');

    expect(response.status).toBe(415);
  });

  /**
   * A preview asked for a file that has gone — deleted in another tab, renamed
   * by someone else — is the ordinary case of a stale listing, not a fault in
   * the server.
   */
  it('answers not found for a file that is not there, rather than a server error', async () => {
    const response = await preview(await setup(), 'gone.png');

    expect(response.status).toBe(404);
  });

  it('answers unsupported for a RAW file whose preview cannot be extracted', async () => {
    const response = await preview(await setup(), 'camera.nef');

    expect(response.status).toBe(415);
  }, 30_000);
});

describe('a path that leaves the volume', () => {
  it.each([['../../../etc/passwd'], ['..%2F..%2Fetc%2Fpasswd'], ['Album/../../outside.png']])(
    'is not served: %s',
    async (file) => {
      const app = await setup();
      await fs.writeFile(path.join(path.dirname(ctx.volumeDir), 'outside.png'), LEAK_MARKER);

      const response = await preview(app, file);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      // A marker of its own, not a word: the refusal message itself says the
      // path is "outside the volume root", and that is fine to say.
      expect(bytesOf(response).toString()).not.toContain(LEAK_MARKER);
      expect(bytesOf(response).toString()).not.toContain('root:');
    }
  );
});

/**
 * A video player never asks for the whole film: it asks for the next few
 * megabytes, and for a point further on when someone drags the playhead.
 */
describe('a film, read in pieces', () => {
  it('says it accepts ranges when sent whole', async () => {
    const response = await preview(await setup(), 'film.mp4').buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toBe('video/mp4');
  });

  it('sends exactly the bytes a range asks for', async () => {
    const response = await preview(await setup(), 'film.mp4')
      .set('Range', 'bytes=10-19')
      .buffer(true);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 10-19/100');
    expect(response.headers['content-length']).toBe('10');
    expect([...bytesOf(response)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('sends the last bytes for a suffix range, not the first', async () => {
    const response = await preview(await setup(), 'film.mp4')
      .set('Range', 'bytes=-5')
      .buffer(true);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 95-99/100');
    expect([...bytesOf(response)]).toEqual([95, 96, 97, 98, 99]);
  });

  it('refuses a range that starts past the end', async () => {
    const response = await preview(await setup(), 'film.mp4').set('Range', 'bytes=200-300');

    expect(response.status).toBe(416);
  });

  it('refuses a range in a unit it does not speak', async () => {
    const response = await preview(await setup(), 'film.mp4').set('Range', 'items=0-1');

    expect(response.status).toBe(416);
  });

  it('keeps the sandbox headers on a partial answer too', async () => {
    const response = await preview(await setup(), 'film.mp4').set('Range', 'bytes=0-1');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('an image, which is not read in pieces', () => {
  it('is sent whole even when a range is asked for', async () => {
    const response = await preview(await setup(), 'photo.png')
      .set('Range', 'bytes=10-19')
      .buffer(true);

    expect(response.status).toBe(200);
    expect(bytesOf(response).length).toBe(100);
    expect(response.headers['accept-ranges']).toBeUndefined();
  });
});

/**
 * Personal folders sit under the volume, at `_users/<name>`. The preview reads
 * bytes, so it is exactly the route through which one account could look at
 * another's photographs if the access check were missing. The file is a PNG on
 * purpose: previewable, so without the check this would be a 200.
 */
describe("another account's personal folder", () => {
  const setupTwoAccounts = async () => {
    const bob = { id: 'bob', username: 'bob', roles: ['user'] };
    const app = await setup({ user: bob, env: { USER_DIR_ENABLED: 'true' } });

    const { resolvePersonalPath } = ctx.requireFresh('src/utils/pathUtils');
    const { getDb } = ctx.requireFresh('src/services/db');
    const db = await getDb();
    const now = new Date().toISOString();
    for (const id of ['alice', 'bob']) {
      db.prepare(
        `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, `${id}@example.com`, 1, id, id, '["user"]', now, now);
    }
    const aliceRoot = await resolvePersonalPath('', { id: 'alice', username: 'alice' });
    await fs.mkdir(aliceRoot, { recursive: true });
    await fs.writeFile(path.join(aliceRoot, 'holiday.png'), 'alice private picture');

    return { app, aliceFolder: path.basename(aliceRoot) };
  };

  it('cannot be previewed through the volume', async () => {
    const { app, aliceFolder } = await setupTwoAccounts();

    const response = await preview(app, `_users/${aliceFolder}/holiday.png`);

    expect(response.status).toBe(403);
    expect(bytesOf(response).toString()).not.toContain('alice private picture');
  });
});
