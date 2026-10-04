import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The thumbnail endpoint is the only authorization a thumbnail ever gets: the
 * image itself is served from /static, outside the auth middleware, and the
 * token in the URL is what carries this route's decision there. That, and the
 * refusals — which deliberately answer not-found rather than forbidden, so a
 * request cannot be used to learn whether a file exists.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'thumbnails-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

const writeImage = async (volume, name) => {
  const file = path.join(volume, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 90, b: 100 } },
  })
    .png()
    .toFile(file);
  return file;
};

const buildApp = () => {
  const routes = currentEnv.requireFresh('src/routes/thumbnails');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

describe('what may have a thumbnail', () => {
  /**
   * Accepted, not refused. What comes back depends on whether generation has
   * finished — 200 with a URL, or 202 with nothing to point at yet — so
   * asserting the shape here made the test fail on a slow runner and pass on
   * mine. The URL is checked by the test below, which waits for it.
   */
  it('accepts an image rather than refusing it', async () => {
    const volume = await seed();
    await writeImage(volume, 'Photos/one.png');

    const response = await request(buildApp()).get('/api/thumbnails/Photos/one.png');

    expect([200, 202]).toContain(response.status);
  });

  /**
   * The static handler that serves the file sits outside the auth middleware,
   * so a thumbnail URL with no token is a file anyone can fetch.
   */
  it('carries a token on the URL it hands back', async () => {
    const volume = await seed();
    await writeImage(volume, 'Photos/two.png');
    const app = buildApp();

    // Generation is queued, so the first answer is usually 202 with nothing to
    // point at yet. Waiting for the real URL is the point: an answer with no
    // thumbnail in it cannot show whether the token would have been on one.
    let thumbnail = '';
    for (let attempt = 0; attempt < 40 && !thumbnail; attempt += 1) {
      const response = await request(app).get('/api/thumbnails/Photos/two.png');
      thumbnail = response.body.thumbnail || '';
      if (!thumbnail) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(thumbnail).not.toBe('');
    expect(thumbnail).toMatch(/[?&]t=/);
  });

  it.each([['pdf'], ['txt'], ['zip']])('refuses a .%s', async (extension) => {
    const volume = await seed();
    await fs.writeFile(path.join(volume, `file.${extension}`), 'content');

    const response = await request(buildApp()).get(`/api/thumbnails/file.${extension}`);

    expect(response.status).toBe(400);
  });

  it('refuses a folder', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Photos'), { recursive: true });

    const response = await request(buildApp()).get('/api/thumbnails/Photos');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Thumbnails are only available for files.');
  });

  it('requires a path', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/thumbnails/');

    expect(response.status).toBe(400);
  });
});

describe('what a refusal gives away', () => {
  /**
   * Not-found rather than forbidden, on purpose: two different answers would
   * let someone map a volume they cannot read by watching which paths come
   * back 403.
   */
  it('says not found for a file that is not there', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/thumbnails/Photos/absent.png');

    expect(response.status).toBe(404);
  });

  it('says not found, not forbidden, for a file the caller may not read', async () => {
    // USER_VOLUMES on and no volume assigned: the path resolves and exists, so
    // the refusal comes from the access check and nowhere else.
    const volume = await seed({ USER_VOLUMES: 'true' });
    await writeImage(volume, 'Photos/private.png');

    const routes = currentEnv.requireFresh('src/routes/thumbnails');
    const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'restricted-user', roles: [] };
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);

    const response = await request(app).get('/api/thumbnails/Photos/private.png');

    expect(response.status).toBe(404);
  });
});

describe('when thumbnails are switched off', () => {
  it('answers empty without looking at the path', async () => {
    await seed({ THUMBNAILS_ENABLED: 'false' });

    // A path that would otherwise be a 404 — the setting is checked first.
    const response = await request(buildApp()).get('/api/thumbnails/Photos/absent.png');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ thumbnail: '' });
  });
});

/**
 * Where the answer points, for a request that arrived under a share's prefix.
 *
 * A thumbnail is fetched by an `<img>`, so the address in the answer is the
 * address the browser goes to — and inside a share that has to be the share's
 * own. The image itself is served from /static, and the fallback for an image
 * whose thumbnail could not be made is the file itself: both were the signed-in
 * application's address, which a visitor behind an authentication proxy cannot
 * reach. The listing of a share drew a broken image for every one of them.
 */
describe('a thumbnail asked for under a share prefix', () => {
  const underAShare = () => {
    const routes = currentEnv.requireFresh('src/routes/thumbnails');
    const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
      // What `requireShareScope` leaves behind for the handlers behind it.
      req.shareScope = { token: 'TOKEN', shareId: 'share-1' };
      next();
    });
    app.use('/api/share/TOKEN', routes);
    app.use(errorHandler);
    return app;
  };

  it('points at the image under that prefix', async () => {
    const volume = await seed();
    await writeImage(volume, 'Photos/shared.png');
    const app = underAShare();

    // 202 while it is still being made, so this waits for the URL.
    let answer;
    await expect
      .poll(
        async () => {
          answer = await request(app).get('/api/share/TOKEN/thumbnails/Photos/shared.png');
          return Boolean(answer.body?.thumbnail);
        },
        { timeout: 15000 }
      )
      .toBe(true);

    expect(answer.body.thumbnail).toMatch(/^\/api\/share\/TOKEN\/static\/thumbnails\//);
  });

  /**
   * And so does the fallback, for an image whose thumbnail could not even be
   * scheduled. Only that failure reaches this branch — a file that merely turns
   * out not to be an image fails later, inside the queue — so the two functions
   * the route calls are replaced by ones that fail, and nothing else is.
   */
  it('points at the file itself under that prefix when no thumbnail can be made', async () => {
    const volume = await seed();
    await writeImage(volume, 'Photos/unschedulable.png');

    const resolved = require.resolve(modulePath('src/services/thumbnailService'));
    const real = require(resolved);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: {
        ...real,
        getThumbnailPathIfExists: async () => null,
        queueThumbnailGeneration: async () => {
          throw new Error('scheduling failed');
        },
      },
    };
    try {
      const answer = await request(underAShare()).get(
        '/api/share/TOKEN/thumbnails/Photos/unschedulable.png'
      );

      expect(answer.status, answer.text).toBe(200);
      expect(answer.body.thumbnail).toBe(
        `/api/share/TOKEN/preview?path=${encodeURIComponent('Photos/unschedulable.png')}`
      );
    } finally {
      delete require.cache[resolved];
    }
  });
});
