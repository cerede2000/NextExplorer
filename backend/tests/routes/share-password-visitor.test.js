import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * A password on a share is for the people who have no account — that is the
 * whole point of a public link. The predicate that answers "does this password
 * apply?" used to require a user, so it said no for exactly those visitors, and
 * every caller made up the difference in its own way. These pin the behaviour
 * the predicate is supposed to describe, from the outside.
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

/** An owner, a volume, and a share on it with a password. */
const seedProtectedShare = async ({ password = 'open-sesame', suffix = '' } = {}) => {
  const usersService = envContext.requireFresh('src/services/users');
  const userVolumesService = envContext.requireFresh('src/services/userVolumesService');
  const root = path.join(envContext.tmpRoot, `visitor-volume${suffix}`);
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'file.txt'), 'hello');

  const owner = await usersService.createLocalUser({
    email: `visitor-owner${suffix}@example.com`,
    username: `visitor-owner${suffix}`,
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  await userVolumesService.addVolumeToUser({
    userId: owner.id,
    label: `VisitorVol${suffix}`,
    volumePath: root,
    accessMode: 'readwrite',
  });

  const created = await request(buildApp({ user: owner }))
    .post('/api/shares')
    .send({ sourcePath: `VisitorVol${suffix}/shared`, sharingType: 'anyone', password });

  expect(created.status).toBe(201);
  return { owner, token: created.body.shareToken };
};

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'share-visitor-', env: { USER_VOLUMES: 'true' } });
});

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a visitor with no account, on a share with a password', () => {
  it('is told the link needs one before being shown anything', async () => {
    const { token } = await seedProtectedShare();

    const info = await request(buildApp()).get(`/api/share/${token}/info`);

    expect(info.status).toBe(200);
    expect(info.body.requiresPassword).toBe(true);
  });

  it('is refused until the password is given', async () => {
    const { token } = await seedProtectedShare();

    const access = await request(buildApp()).get(`/api/share/${token}/access`);

    expect(access.status).toBe(401);
  });

  it('gets in once it is', async () => {
    const { token } = await seedProtectedShare();
    const app = buildApp();

    const verify = await request(app)
      .post(`/api/share/${token}/verify`)
      .send({ password: 'open-sesame' });

    expect(verify.status).toBe(200);
    expect(verify.body.guestSessionId).toBeTruthy();
  });

  // Reloading the page calls /access again. A visitor who has just typed the
  // password was asked for it a second time, for the share they had been given.
  it('is not asked again when the page is reloaded', async () => {
    const { token } = await seedProtectedShare();
    const app = buildApp();

    const verify = await request(app)
      .post(`/api/share/${token}/verify`)
      .send({ password: 'open-sesame' });
    const again = await request(app)
      .get(`/api/share/${token}/access`)
      .set({ 'X-Guest-Session': verify.body.guestSessionId });

    expect(again.status).toBe(200);
    expect(again.body.guestSessionId).toBe(verify.body.guestSessionId);
  });

  // One cookie holds one share: a session for another link is not a way in.
  it('is asked when the session it carries belongs to another share', async () => {
    const first = await seedProtectedShare();
    const second = await seedProtectedShare({ password: 'different', suffix: '-2' });

    const verified = await request(buildApp())
      .post(`/api/share/${first.token}/verify`)
      .send({ password: 'open-sesame' });
    expect(verified.body.guestSessionId).toBeTruthy();

    const access = await request(buildApp())
      .get(`/api/share/${second.token}/access`)
      .set({ 'X-Guest-Session': verified.body.guestSessionId });

    expect(access.status).toBe(401);
  });
});

describe('the owner of a share with a password', () => {
  it('is not asked for it', async () => {
    const { owner, token } = await seedProtectedShare();

    const info = await request(buildApp({ user: owner })).get(`/api/share/${token}/info`);

    expect(info.status).toBe(200);
    expect(info.body.requiresPassword).toBe(false);
  });
});
