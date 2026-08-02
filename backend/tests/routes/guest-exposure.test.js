import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The auth middleware lets any guest session through on every /api route, so
 * endpoints that are not share-scoped have to say no themselves. These pin the
 * ones that were answering to share visitors — and to anonymous callers.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const buildApp = ({ routes, mountPath, user, guestSession }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    if (guestSession) req.guestSession = guestSession;
    next();
  });
  app.use(mountPath, routes);
  return app;
};

describe('Volume listing', () => {
  it('returns nothing to a share visitor and to an anonymous caller', async () => {
    const env = await setupTestEnv({
      tag: 'guest-volumes-',
      modules: [
        'src/config/env',
        'src/config/index',
        'src/utils/pathUtils',
        'src/routes/volumes',
        'src/services/accessManager',
      ],
    });
    currentEnv = env;

    await fs.mkdir(path.join(env.volumeDir, 'Private'), { recursive: true });
    const volumesRoutes = env.requireFresh('src/routes/volumes');

    const guest = await request(
      buildApp({
        routes: volumesRoutes,
        mountPath: '/api',
        guestSession: { id: 'guest-1', shareId: 'share-1' },
      })
    ).get('/api/volumes');
    expect(guest.status).toBe(200);
    expect(guest.body).toEqual([]);

    const anonymous = await request(
      buildApp({ routes: volumesRoutes, mountPath: '/api' })
    ).get('/api/volumes');
    expect(anonymous.body).toEqual([]);

    // A real user still sees the volumes.
    const member = await request(
      buildApp({
        routes: volumesRoutes,
        mountPath: '/api',
        user: { id: 'user-1', roles: ['user'] },
      })
    ).get('/api/volumes');
    expect(member.status).toBe(200);
    expect(Array.isArray(member.body)).toBe(true);
    expect(member.body.length).toBeGreaterThan(0);
  });
});

describe('Folder size lookup', () => {
  it('does not resolve volume paths for a share visitor', async () => {
    const env = await setupTestEnv({
      tag: 'guest-folder-size-',
      env: { FOLDER_SIZE_MODE: 'index' },
      modules: [
        'src/config/env',
        'src/config/index',
        'src/utils/pathUtils',
        'src/services/db',
        'src/routes/folderSize',
        'src/services/accessManager',
        'src/services/folderSizeIndex',
      ],
    });
    currentEnv = env;

    const secret = path.join(env.volumeDir, 'Private');
    await fs.mkdir(secret, { recursive: true });
    await fs.writeFile(path.join(secret, 'a.bin'), Buffer.alloc(4096, 1));

    const folderSizeRoutes = env.requireFresh('src/routes/folderSize');
    const app = buildApp({
      routes: folderSizeRoutes,
      mountPath: '/api',
      guestSession: { id: 'guest-1', shareId: 'share-1' },
    });

    const response = await request(app).get('/api/folder-size').query({ path: 'Private' });

    // Whatever the transport says, no size may come back for a guest.
    if (response.status === 200) {
      const payload = response.body?.result || response.body;
      expect(payload?.sizeBytes ?? null).toBeNull();
      expect(payload?.indexed ?? false).toBe(false);
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});
