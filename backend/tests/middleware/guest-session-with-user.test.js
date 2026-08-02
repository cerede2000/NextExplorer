import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * These mount the real auth middleware on purpose.
 *
 * The password check on protected shares reads req.guestSession, which is the
 * only proof a signed-in visitor typed the password. An earlier build deleted
 * that session as soon as a user was attached, so the check could never be
 * satisfied: the visitor typed the right password and still got 401 on every
 * request. Test harnesses that fake the middleware cannot see that — this one
 * runs the middleware itself.
 */

let env;
let owner;
let visitor;
let share;

beforeAll(async () => {
  env = await setupTestEnv({
    tag: 'guest-session-with-user-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/utils/pathUtils',
      'src/services/db',
      'src/services/users',
      'src/services/sharesService',
      'src/services/guestSessionService',
      'src/services/accessManager',
      'src/middleware/authMiddleware',
      'src/middleware/errorHandler',
      'src/routes/shares',
    ],
  });

  const usersService = env.requireFresh('src/services/users');
  const sharesService = env.requireFresh('src/services/sharesService');

  owner = await usersService.createLocalUser({
    email: 'owner@example.com',
    username: 'owner',
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  visitor = await usersService.createLocalUser({
    email: 'visitor@example.com',
    username: 'visitor',
    displayName: 'Visitor',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(path.join(env.volumeDir, 'shared'), { recursive: true });
  share = await sharesService.createShare({
    ownerId: owner.id,
    sourcePath: 'shared',
    sourceSpace: 'volume',
    isDirectory: true,
    accessMode: 'readonly',
    sharingType: 'anyone',
    password: 'link-password',
  });
});

afterAll(async () => {
  if (env) await env.cleanup();
});

const buildApp = ({ sessionUserId } = {}) => {
  const authMiddleware = env.requireFresh('src/middleware/authMiddleware');
  const sharesRoutes = env.requireFresh('src/routes/shares');
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // express-session normally provides this; only the shape matters here.
  app.use((req, _res, next) => {
    req.session = sessionUserId ? { localUserId: sessionUserId } : {};
    next();
  });
  app.use(authMiddleware);
  app.use('/api/share', sharesRoutes);
  app.use(errorHandler);
  return app;
};

describe('Protected share, signed-in visitor', () => {
  it('grants access once the password has been verified', async () => {
    const app = buildApp({ sessionUserId: visitor.id });

    // Without verification the visitor is refused, signed in or not.
    const before = await request(app).get(`/api/share/${share.shareToken}/access`);
    expect(before.status).toBe(401);

    // Verifying the password issues the guest session...
    const verify = await request(app)
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'link-password' });
    expect(verify.status).toBe(200);
    // A browser applies the deletion and sends back only what is left; supertest
    // would replay the emptied cookie as-is.
    const cookies = verify.headers['set-cookie'].filter(
      (value) => !/^guestSession=;/.test(value)
    );

    // ...and the very next request has to be accepted. It used to 401 forever.
    const after = await request(app)
      .get(`/api/share/${share.shareToken}/access`)
      .set('Cookie', cookies);
    expect(after.status).toBe(200);
  });

  it('drops the /api-scoped cookie an earlier build left behind', async () => {
    const verify = await request(buildApp())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'link-password' });

    const cookies = verify.headers['set-cookie'];
    // Same name on two paths means the stale /api one wins on /api requests,
    // so it has to be deleted, not just overwritten.
    expect(cookies.some((value) => /^guestSession=;/.test(value) && /Path=\/api/.test(value))).toBe(
      true
    );
    expect(cookies.some((value) => /^guestSession=[^;]+/.test(value) && /Path=\//.test(value))).toBe(
      true
    );
  });

  it('lets the owner in without the password', async () => {
    const app = buildApp({ sessionUserId: owner.id });

    const response = await request(app).get(`/api/share/${share.shareToken}/access`);
    expect(response.status).toBe(200);

    // And the router is told, so it does not send them to the prompt either.
    const info = await request(app).get(`/api/share/${share.shareToken}/info`);
    expect(info.body.hasPassword).toBe(true);
    expect(info.body.requiresPassword).toBe(false);
  });

  it('still asks a signed-in stranger', async () => {
    const info = await request(buildApp({ sessionUserId: visitor.id })).get(
      `/api/share/${share.shareToken}/info`
    );
    expect(info.body.requiresPassword).toBe(true);
  });
});
