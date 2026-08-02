import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Thumbnails live outside /api, so they get their own gate. It has to keep
 * anonymous callers out *without* breaking share visitors: their credential is
 * a cookie, because an <img> tag cannot send a header.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const buildApp = async (env) => {
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

const seedThumbnail = async (env) => {
  const dir = path.join(env.cacheDir, 'thumbnails');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'v3-abc.webp'), Buffer.from('fake-webp'));
};

describe('Thumbnail access', () => {
  it('refuses an anonymous caller', async () => {
    const env = await setupTestEnv({
      tag: 'thumbnails-anon-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/staticServer'],
    });
    currentEnv = env;
    await seedThumbnail(env);

    const response = await request(await buildApp(env)).get('/static/thumbnails/v3-abc.webp');
    expect(response.status).toBe(401);
  });

  it('serves a signed-in user', async () => {
    const env = await setupTestEnv({
      tag: 'thumbnails-user-',
      modules: ['src/config/env', 'src/config/index', 'src/utils/staticServer'],
    });
    currentEnv = env;
    await seedThumbnail(env);

    const response = await request(await buildApp(env))
      .get('/static/thumbnails/v3-abc.webp')
      .set('x-signed-in', '1');
    expect(response.status).toBe(200);
  });

  // Known limitation: the gate checks that the guest session exists, not that
  // the thumbnail belongs to that share — the cache filename carries no share.
  // A visitor who guessed another share's filename would be served. That is
  // still narrower than before, when the whole directory was public.
  it('serves any valid guest session, share-scoped or not', async () => {
    const env = await setupTestEnv({
      tag: 'thumbnails-guest-',
      modules: [
        'src/config/env',
        'src/config/index',
        'src/utils/pathUtils',
        'src/services/db',
        'src/services/users',
        'src/services/sharesService',
        'src/services/guestSessionService',
        'src/utils/staticServer',
      ],
    });
    currentEnv = env;
    await seedThumbnail(env);

    // The guest session references a real share (foreign key).
    const usersService = env.requireFresh('src/services/users');
    const sharesService = env.requireFresh('src/services/sharesService');
    const owner = await usersService.createLocalUser({
      email: 'thumb-owner@example.com',
      username: 'thumb-owner',
      displayName: 'Thumb Owner',
      password: 'secret123',
      roles: ['user'],
    });
    await fs.mkdir(path.join(env.volumeDir, 'shared'), { recursive: true });
    const share = await sharesService.createShare({
      ownerId: owner.id,
      sourcePath: 'shared',
      sourceSpace: 'volume',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });

    const { createGuestSession } = env.requireFresh('src/services/guestSessionService');
    const session = await createGuestSession({
      shareId: share.id,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    const response = await request(await buildApp(env))
      .get('/static/thumbnails/v3-abc.webp')
      .set('Cookie', `guestSession=${session.id}`);

    expect(response.status).toBe(200);
  });
});
