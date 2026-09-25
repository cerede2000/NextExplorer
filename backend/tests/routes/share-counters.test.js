import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * What a share's numbers mean.
 *
 * Opening a link is not downloading from it. Both used to raise the same
 * counter, so the "downloads" an owner was shown counted every page load and
 * every reload — a link opened twenty times and never downloaded from read as
 * twenty downloads, and there was no number at all for how often it had been
 * opened.
 */

let envContext;

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const sharesRoutes = envContext.requireFresh('src/routes/shares');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const authMiddleware = envContext.requireFresh('src/middleware/authMiddleware');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.session = user ? { localUserId: user.id } : {};
    next();
  });
  app.use(authMiddleware);
  app.use('/api/shares', sharesRoutes);
  app.use('/api/share', sharesRoutes);
  app.use(errorHandler);
  return app;
};

/** An owner, a volume with a file in it, and a link anybody may open. */
const seedShare = async () => {
  const usersService = envContext.requireFresh('src/services/users');
  const userVolumesService = envContext.requireFresh('src/services/userVolumesService');
  const root = path.join(envContext.tmpRoot, 'counted-volume');
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'file.txt'), 'hello');

  const owner = await usersService.createLocalUser({
    email: 'counter-owner@example.com',
    username: 'counter-owner',
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  await userVolumesService.addVolumeToUser({
    userId: owner.id,
    label: 'CountedVol',
    volumePath: root,
    accessMode: 'readwrite',
  });

  const created = await request(buildApp({ user: owner }))
    .post('/api/shares')
    .send({ sourcePath: 'CountedVol/shared', sharingType: 'anyone' });

  expect(created.status).toBe(201);
  return { owner, token: created.body.shareToken, id: created.body.id };
};

/** The numbers as the owner reads them. */
const numbers = async (id) => {
  const shares = envContext.requireFresh('src/services/sharesService');
  const stats = await shares.getShareStats(id);
  return { opened: stats.accessCount, downloaded: stats.downloadCount };
};

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'share-counters-', env: { USER_VOLUMES: 'true' } });
});

afterEach(async () => {
  await envContext.cleanup();
});

describe('a share link', () => {
  it('counts an open as an open, not as a download', async () => {
    const { token, id } = await seedShare();
    const app = buildApp();

    expect(await numbers(id)).toEqual({ opened: 0, downloaded: 0 });

    expect((await request(app).get(`/api/share/${token}/access`)).status).toBe(200);
    expect((await request(app).get(`/api/share/${token}/access`)).status).toBe(200);

    expect(await numbers(id)).toEqual({ opened: 2, downloaded: 0 });
  });

  it('counts a file leaving as a download', async () => {
    const { token, id } = await seedShare();
    const app = buildApp();

    await request(app).get(`/api/share/${token}/access`);
    const file = await request(app).get(`/api/share/${token}/file/file.txt`);

    expect(file.status).toBe(200);
    expect(await numbers(id)).toEqual({ opened: 1, downloaded: 1 });
  });

  it('remembers when it was last reached, whichever way', async () => {
    const { token, id } = await seedShare();
    const app = buildApp();

    await request(app).get(`/api/share/${token}/access`);

    const shares = envContext.requireFresh('src/services/sharesService');
    const stats = await shares.getShareStats(id);
    expect(stats.lastAccessedAt).toBeTruthy();
  });
});
