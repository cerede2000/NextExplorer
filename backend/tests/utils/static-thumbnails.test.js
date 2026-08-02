import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Thumbnails are served from /static, outside the auth middleware, so the URL
 * carries its own proof: a signature minted by /api/thumbnails once the real
 * access check passed, naming the one file it unlocks.
 *
 * A session cookie cannot do that job — it identifies the caller without
 * saying what they were cleared to see, so a share visitor could ask for a
 * filename belonging to another share. These pin that the signature is
 * required, file-scoped, and time-limited.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const MODULES = ['src/config/env', 'src/config/index', 'src/utils/staticServer'];

const buildApp = (env) => {
  const { configureStaticFiles } = env.requireFresh('src/utils/staticServer');
  const app = express();
  app.use(cookieParser());
  // express-session normally provides this; only the shape matters here.
  app.use((req, _res, next) => {
    req.session = req.headers['x-signed-in'] ? { localUserId: 'user-1' } : {};
    next();
  });
  configureStaticFiles(app);
  return app;
};

const seedThumbnail = async (env, name = 'v3-abc.webp') => {
  const dir = path.join(env.cacheDir, 'thumbnails');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), Buffer.from('fake-webp'));
};

describe('Thumbnail access', () => {
  it('refuses a request with no token, signed in or not', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-no-token-', modules: MODULES });
    currentEnv = env;
    await seedThumbnail(env);
    const app = buildApp(env);

    const anonymous = await request(app).get('/static/thumbnails/v3-abc.webp');
    expect(anonymous.status).toBe(401);

    // Being signed in is not the point: this endpoint answers to the token
    // issued for one file, not to whoever happens to hold a session.
    const signedIn = await request(app)
      .get('/static/thumbnails/v3-abc.webp')
      .set('x-signed-in', '1');
    expect(signedIn.status).toBe(401);
  });

  it('serves the file the token was issued for', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-token-', modules: MODULES });
    currentEnv = env;
    await seedThumbnail(env);

    const { createThumbnailToken } = env.requireFresh('src/utils/thumbnailTokens');
    const response = await request(buildApp(env))
      .get('/static/thumbnails/v3-abc.webp')
      .query({ t: createThumbnailToken('v3-abc.webp') });

    expect(response.status).toBe(200);
  });

  it('refuses a token issued for another file', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-other-file-', modules: MODULES });
    currentEnv = env;
    await seedThumbnail(env, 'v3-mine.webp');
    await seedThumbnail(env, 'v3-someone-else.webp');

    const { createThumbnailToken } = env.requireFresh('src/utils/thumbnailTokens');
    // This is the case a session check could never catch: a legitimate visitor
    // reusing their own credential against a filename they were never cleared
    // for.
    const response = await request(buildApp(env))
      .get('/static/thumbnails/v3-someone-else.webp')
      .query({ t: createThumbnailToken('v3-mine.webp') });

    expect(response.status).toBe(401);
  });

  it('refuses an expired or tampered token', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-expired-', modules: MODULES });
    currentEnv = env;
    await seedThumbnail(env);

    const { createThumbnailToken, TTL_MS } = env.requireFresh('src/utils/thumbnailTokens');
    const app = buildApp(env);

    const expired = createThumbnailToken('v3-abc.webp', Date.now() - TTL_MS - 1000);
    expect((await request(app).get('/static/thumbnails/v3-abc.webp').query({ t: expired })).status).toBe(
      401
    );

    // Pushing the expiry out by hand invalidates the signature.
    const valid = createThumbnailToken('v3-abc.webp');
    const forged = `${Date.now() + 10 * 60 * 1000}.${valid.split('.')[1]}`;
    expect((await request(app).get('/static/thumbnails/v3-abc.webp').query({ t: forged })).status).toBe(
      401
    );
  });

  it('does not let a token unlock a nested path with the same basename', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-nested-', modules: MODULES });
    currentEnv = env;
    const dir = path.join(env.cacheDir, 'thumbnails', 'sub');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'v3-abc.webp'), Buffer.from('fake-webp'));

    const { createThumbnailToken } = env.requireFresh('src/utils/thumbnailTokens');
    const response = await request(buildApp(env))
      .get('/static/thumbnails/sub/v3-abc.webp')
      .query({ t: createThumbnailToken('v3-abc.webp') });

    expect(response.status).toBe(401);
  });

  it('answers a malformed URL with 401 rather than a crash', async () => {
    const env = await setupTestEnv({ tag: 'thumbnails-malformed-', modules: MODULES });
    currentEnv = env;
    await seedThumbnail(env);

    const response = await request(buildApp(env)).get('/static/thumbnails/%zz.webp');
    expect(response.status).toBe(401);
  });

  it('serves everything when authentication is disabled', async () => {
    const env = await setupTestEnv({
      tag: 'thumbnails-no-auth-',
      env: { AUTH_MODE: 'disabled' },
      modules: MODULES,
    });
    currentEnv = env;
    await seedThumbnail(env);

    const response = await request(buildApp(env)).get('/static/thumbnails/v3-abc.webp');
    expect(response.status).toBe(200);
  });
});
