import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * Everything a share's visitor asks for, under the share's own prefix.
 *
 * A visitor used to ask at the application's own addresses — `/api/preview`,
 * `/api/download`, `/api/thumbnails/…`. The server checked the share behind each
 * of them, so none of it was open; but a share is what somebody opens from the far
 * side of an authentication proxy, and such a proxy lets a public link through by
 * path. With a visitor's requests scattered across the API, letting the link
 * through meant opening `/api/download` to the world, for every file in the
 * instance and not just the shared one.
 *
 * So the same handlers also answer under `/api/share/<token>/…`. The claim that
 * makes this safe is the one this file exists to hold: **the prefix adds a
 * requirement and removes none.** It is never anonymous, a guest session is only
 * good for the share it was issued for, and the handler's own access check runs
 * afterwards, unchanged.
 */

let envContext;

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const registerRoutes = envContext.requireFresh('src/routes/index');
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
  registerRoutes(app);
  app.use(errorHandler);
  return app;
};

/** An owner with a volume, and a public share of a folder on it. */
const seedShare = async ({ suffix = '', password, accessMode } = {}) => {
  const usersService = envContext.requireFresh('src/services/users');
  const userVolumesService = envContext.requireFresh('src/services/userVolumesService');
  const root = path.join(envContext.tmpRoot, `scoped-volume${suffix}`);
  await fs.mkdir(path.join(root, 'handed-out'), { recursive: true });
  await fs.writeFile(path.join(root, 'handed-out', 'file.txt'), 'the shared bytes');
  // The viewer only opens what it can draw, so the preview is asked about this.
  await fs.writeFile(
    path.join(root, 'handed-out', 'picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  // Beside the shared folder, never inside it: what the prefix must not reach.
  await fs.writeFile(path.join(root, 'private.txt'), 'not shared with anybody');

  const owner = await usersService.createLocalUser({
    email: `scoped-owner${suffix}@example.com`,
    username: `scoped-owner${suffix}`,
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  await userVolumesService.addVolumeToUser({
    userId: owner.id,
    label: `ScopedVol${suffix}`,
    volumePath: root,
    accessMode: 'readwrite',
  });

  const created = await request(buildApp({ user: owner }))
    .post('/api/shares')
    .send({
      sourcePath: `ScopedVol${suffix}/handed-out`,
      sharingType: 'anyone',
      ...(accessMode ? { accessMode } : {}),
      ...(password ? { password } : {}),
    });
  expect(created.status).toBe(201);

  // A protected share hands out no session until somebody types the password,
  // which is exactly the case one of these asks about.
  const access = password
    ? null
    : await request(buildApp()).get(`/api/share/${created.body.shareToken}/access`);
  if (access) expect(access.status).toBe(200);

  return {
    owner,
    volume: `ScopedVol${suffix}`,
    token: created.body.shareToken,
    guestSession: access?.body?.guestSessionId || null,
  };
};

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'share-scoped-',
    // The resumable uploader is off unless an administrator turns it on, and one
    // of these asks where it tells a client to send the rest of a file.
    env: { USER_VOLUMES: 'true', UPLOAD_CHUNKED_ENABLED: 'true' },
  });
});

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('the application, answering under a share prefix', () => {
  it('hands a visitor the file they came for', async () => {
    const { token, guestSession } = await seedShare();

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/picture.png` })
      .set({ 'X-Guest-Session': guestSession });

    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('image/png');
  });

  it('lets them take it away', async () => {
    const { token, guestSession } = await seedShare();

    const download = await request(buildApp())
      .post(`/api/share/${token}/download`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ paths: [`share/${token}/file.txt`], basePath: `share/${token}` });

    expect(download.status).toBe(200);
  });
});

describe('what a share answers before anybody is identified', () => {
  /**
   * A visitor behind an authentication proxy reaches the share's prefix and
   * nothing else. Both of these are already answered to anybody at their own
   * addresses, and falling back to defaults is not good enough: whether this
   * installation has an office editor at all is one of these flags.
   */
  it('tells the page what it is drawing itself with', async () => {
    const { token } = await seedShare({ suffix: '-chrome' });
    const app = buildApp();

    const features = await request(app).get(`/api/share/${token}/features`);
    const branding = await request(app).get(`/api/share/${token}/branding`);

    expect(features.status).toBe(200);
    expect(branding.status).toBe(200);
    // The same answer as the address every other page reads them at.
    expect(features.body).toEqual((await request(app).get('/api/features')).body);
    expect(branding.body).toEqual((await request(app).get('/api/branding')).body);
  });
});

describe('an upload begun under a share prefix', () => {
  /**
   * A resumable upload is told where to send the rest of itself by the answer to
   * its first request. Built from the one path the server is configured with,
   * that answer pointed at `/api/upload/tus` — an address the visitor cannot
   * reach, so every chunk after the first was refused by the proxy.
   */
  it('is told to continue under the same prefix', async () => {
    const { token, guestSession } = await seedShare({
      suffix: '-tus',
      accessMode: 'readwrite',
    });

    const created = await request(buildApp())
      .post(`/api/share/${token}/upload/tus`)
      .set({
        'X-Guest-Session': guestSession,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '19',
        'Upload-Metadata': `uploadTo ${Buffer.from(`share/${token}`).toString('base64')},name ${Buffer.from('left-here.txt').toString('base64')}`,
      });

    expect(created.status, created.text || JSON.stringify(created.body)).toBe(201);
    expect(created.headers.location).toContain(`/api/share/${token}/upload/tus/`);
    expect(created.headers.location).not.toContain('/api/upload/tus');
  });
});

describe('what the share prefix refuses', () => {
  it('refuses anybody carrying nothing at all', async () => {
    const { token } = await seedShare();

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/file.txt` });

    expect(preview.status).toBe(401);
  });

  it('refuses a session issued for another share', async () => {
    const mine = await seedShare();
    const theirs = await seedShare({ suffix: '-2' });

    const preview = await request(buildApp())
      .get(`/api/share/${theirs.token}/preview`)
      .query({ path: `share/${theirs.token}/file.txt` })
      .set({ 'X-Guest-Session': mine.guestSession });

    expect(preview.status).toBe(403);
  });

  /**
   * The prefix is an address, not a right. A visitor holding a session for a
   * share cannot use it to ask about anything outside that share — the handler
   * resolves the path it was given, exactly as it does at its own address.
   */
  it('refuses a path outside the share it was issued for', async () => {
    const { token, volume, guestSession } = await seedShare();

    for (const outside of [`${volume}/private.txt`, 'personal/anything.txt']) {
      const preview = await request(buildApp())
        .get(`/api/share/${token}/preview`)
        .query({ path: outside })
        .set({ 'X-Guest-Session': guestSession });

      expect(preview.status, outside).toBe(403);
    }
  });

  it('refuses a token that names no share', async () => {
    const { guestSession } = await seedShare();

    const preview = await request(buildApp())
      .get('/api/share/not-a-share/preview')
      .query({ path: 'share/not-a-share/file.txt' })
      .set({ 'X-Guest-Session': guestSession });

    expect(preview.status).toBe(404);
  });

  /**
   * A password is what the session proves. Without one the prefix is shut, which
   * is the same answer `/api/preview` gives — and the point is that it is the
   * same answer: moving the address moved no decision.
   */
  it('refuses a protected share to somebody who never typed the password', async () => {
    const { token } = await seedShare({ suffix: '-3', password: 'open-sesame' });

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/file.txt` });

    expect(preview.status).toBe(401);
  });
});
