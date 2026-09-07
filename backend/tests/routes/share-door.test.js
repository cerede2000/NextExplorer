import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * The three routes a shared link is opened through.
 *
 * `/info` is answered to anyone holding a token, before any password has been
 * typed — so what it does *not* say matters as much as what it does: where the
 * file lives on the server, and who the share was named to, are not a visitor's
 * to learn from a link they may not even be able to open.
 *
 * `/verify` and `/access` are the door itself. Between them they decide who
 * gets a guest session, who is sent to sign in, and who is turned away — and
 * the rules are not symmetrical: a password protects a link from everyone but
 * its owner, being signed in is not the same as knowing it, and a share named
 * to people is not opened by a password at all.
 */

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'share-door-test-',
    env: { USER_VOLUMES: 'true' },
    modules: [
      'src/services/db',
      'src/services/users',
      'src/services/userVolumesService',
      'src/services/sharesService',
      'src/services/guestSessionService',
      'src/utils/pathUtils',
      'src/middleware/authMiddleware',
      'src/middleware/errorHandler',
      'src/routes/shares',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

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

let seq = 0;

/** An owner with a volume of their own, and something in it. */
const makeOwner = async (files = { 'hello.txt': 'bonjour' }) => {
  seq += 1;
  const usersService = envContext.requireFresh('src/services/users');
  const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

  const root = path.join(envContext.tmpRoot, `door-volume-${seq}`);
  await fs.mkdir(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(path.join(root, name), contents);
  }

  const user = await usersService.createLocalUser({
    email: `door-${seq}@example.com`,
    username: `door-${seq}`,
    displayName: `Door ${seq}`,
    password: 'secret123',
    roles: ['user'],
  });
  const label = `DoorVol${seq}`;
  await userVolumesService.addVolumeToUser({
    userId: user.id,
    label,
    volumePath: root,
    accessMode: 'readwrite',
  });

  return { user, label, root };
};

const createShare = async (user, body) => {
  const response = await request(buildApp({ user })).post('/api/shares').send(body);
  expect(response.status).toBe(201);
  return response.body;
};

const visitor = () => buildApp();

describe('what a link tells someone holding it', () => {
  it('names the share and says what it is', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      label: 'Le mot de passe du wifi',
    });

    const info = await request(visitor()).get(`/api/share/${share.shareToken}/info`);

    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      shareToken: share.shareToken,
      label: 'Le mot de passe du wifi',
      isDirectory: false,
      hasPassword: false,
      sharingType: 'anyone',
      isExpired: false,
    });
  });

  /**
   * A token is not a permission. Anyone who has one — from a forwarded message,
   * a browser history, a proxy log — can call this before typing a password, so
   * it must not describe the server's filesystem or name the people the share
   * was made for.
   */
  it('says nothing about where the file lives or who it was made for', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });

    const info = await request(visitor()).get(`/api/share/${share.shareToken}/info`);

    expect(Object.keys(info.body).sort()).toEqual([
      'expiresAt',
      'hasPassword',
      'isDirectory',
      'isExpired',
      'label',
      'requiresPassword',
      'sharingType',
      'shareToken',
    ].sort());
    expect(JSON.stringify(info.body)).not.toContain(label);
  });

  it('says a protected link wants a password', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const info = await request(visitor()).get(`/api/share/${share.shareToken}/info`);

    expect(info.body).toMatchObject({ hasPassword: true, requiresPassword: true });
  });

  /**
   * The owner of a protected link is not sent to a prompt the API would let
   * them skip — the router reads this field, so the two have to agree.
   */
  it('does not ask its own owner for the password', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const info = await request(buildApp({ user })).get(`/api/share/${share.shareToken}/info`);

    expect(info.body).toMatchObject({ hasPassword: true, requiresPassword: false });
  });

  it('says an expired link has expired', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const sharesService = envContext.requireFresh('src/services/sharesService');
    const dbService = envContext.requireFresh('src/services/db');
    const db = await dbService.getDb();
    db.prepare('UPDATE shares SET expires_at = ? WHERE share_token = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      share.shareToken
    );
    expect(sharesService).toBeTruthy();

    const info = await request(visitor()).get(`/api/share/${share.shareToken}/info`);

    expect(info.body.isExpired).toBe(true);
  });

  it('answers a token that was never a share with a plain not-found', async () => {
    const info = await request(visitor()).get('/api/share/pas-un-jeton/info');

    expect(info.status).toBe(404);
  });
});

describe('typing the password on a link', () => {
  const lockedShare = async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });
    return { user, share };
  };

  it('opens it, and hands back a session for this share', async () => {
    const { share } = await lockedShare();

    const verified = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'ouvre-toi' });

    expect(verified.status).toBe(200);
    expect(verified.body.success).toBe(true);
    expect(verified.body.guestSessionId).toBeTruthy();
  });

  it('sets the session as a cookie, so a reload keeps it', async () => {
    const { share } = await lockedShare();

    const verified = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'ouvre-toi' });

    expect(String(verified.headers['set-cookie'])).toContain('guest');
  });

  it('refuses the wrong one, and hands back nothing', async () => {
    const { share } = await lockedShare();

    const refused = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'au-hasard' });

    expect(refused.status).toBe(401);
    expect(refused.body.guestSessionId).toBeUndefined();
  });

  it('refuses an empty one', async () => {
    const { share } = await lockedShare();

    const refused = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({});

    expect(refused.status).toBe(401);
  });

  /** A link that has run out is not opened by the right password either. */
  it('refuses an expired link whatever is typed', async () => {
    const { share } = await lockedShare();
    const db = await envContext.requireFresh('src/services/db').getDb();
    db.prepare('UPDATE shares SET expires_at = ? WHERE share_token = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      share.shareToken
    );

    const refused = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'ouvre-toi' });

    expect(refused.status).toBe(403);
  });

  /**
   * A share named to people is not opened by knowing something. The visitor is
   * told to sign in rather than handed a session.
   */
  it('sends a named share to sign in rather than opening it', async () => {
    const { user, label } = await makeOwner();
    const other = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [other.user.id],
      password: 'ouvre-toi',
    });

    const verified = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'ouvre-toi' });

    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ success: true, requiresAuth: true });
    expect(verified.body.guestSessionId).toBeUndefined();
  });

  it('opens a link with no password at all, for anyone', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });

    const verified = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({});

    expect(verified.status).toBe(200);
    expect(verified.body.guestSessionId).toBeTruthy();
  });

  it('still requires signing in for a named share with no password', async () => {
    const { user, label } = await makeOwner();
    const other = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [other.user.id],
    });

    const refused = await request(visitor())
      .post(`/api/share/${share.shareToken}/verify`)
      .send({});

    expect(refused.status).toBe(401);
  });

  it('answers a token that was never a share with a plain not-found', async () => {
    const refused = await request(visitor())
      .post('/api/share/pas-un-jeton/verify')
      .send({ password: 'x' });

    expect(refused.status).toBe(404);
  });
});

describe('opening a link', () => {
  it('gives a visitor a session and describes what they may do', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });

    const opened = await request(visitor()).get(`/api/share/${share.shareToken}/access`);

    expect(opened.status).toBe(200);
    expect(opened.body.guestSessionId).toBeTruthy();
    expect(opened.body.share).toMatchObject({
      shareToken: share.shareToken,
      sourcePath: `share/${share.shareToken}`,
      accessMode: 'readonly',
      allowDownload: true,
      isDirectory: false,
    });
  });

  /** Being signed in is not knowing the password. */
  it('refuses a protected link to a visitor who has not typed the password', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const refused = await request(visitor()).get(`/api/share/${share.shareToken}/access`);

    expect(refused.status).toBe(401);
  });

  it('refuses it to a signed-in stranger too', async () => {
    const { user, label } = await makeOwner();
    const stranger = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const refused = await request(buildApp({ user: stranger.user })).get(
      `/api/share/${share.shareToken}/access`
    );

    expect(refused.status).toBe(401);
  });

  it('opens it for its owner without a password', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const opened = await request(buildApp({ user })).get(`/api/share/${share.shareToken}/access`);

    expect(opened.status).toBe(200);
  });

  /**
   * Reloading the page calls here again. A visitor who has just typed the
   * password holds a session that says so, and asking for it a second time —
   * for a share they were just given — is how this went wrong before.
   */
  it('accepts the session a visitor was just handed', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });
    const app = visitor();
    const agent = request.agent(app);
    const verified = await agent
      .post(`/api/share/${share.shareToken}/verify`)
      .send({ password: 'ouvre-toi' });
    expect(verified.status).toBe(200);

    const opened = await agent.get(`/api/share/${share.shareToken}/access`);

    expect(opened.status).toBe(200);
    expect(opened.body.guestSessionId).toBe(verified.body.guestSessionId);
  });

  it('refuses a named share to somebody not on it', async () => {
    const { user, label } = await makeOwner();
    const invited = await makeOwner();
    const stranger = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [invited.user.id],
    });

    const refused = await request(buildApp({ user: stranger.user })).get(
      `/api/share/${share.shareToken}/access`
    );

    expect(refused.status).toBe(403);
  });

  it('opens it for somebody who is on it', async () => {
    const { user, label } = await makeOwner();
    const invited = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [invited.user.id],
    });

    const opened = await request(buildApp({ user: invited.user })).get(
      `/api/share/${share.shareToken}/access`
    );

    expect(opened.status).toBe(200);
  });

  it('asks a signed-out visitor of a named share to sign in', async () => {
    const { user, label } = await makeOwner();
    const invited = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'users',
      userIds: [invited.user.id],
    });

    const refused = await request(visitor()).get(`/api/share/${share.shareToken}/access`);

    expect(refused.status).toBe(401);
  });

  it('refuses an expired link to everyone, its owner included', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });
    const db = await envContext.requireFresh('src/services/db').getDb();
    db.prepare('UPDATE shares SET expires_at = ? WHERE share_token = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      share.shareToken
    );

    expect((await request(visitor()).get(`/api/share/${share.shareToken}/access`)).status).toBe(
      403
    );
    expect(
      (await request(buildApp({ user })).get(`/api/share/${share.shareToken}/access`)).status
    ).toBe(403);
  });

  it('answers a token that was never a share with a plain not-found', async () => {
    const refused = await request(visitor()).get('/api/share/pas-un-jeton/access');

    expect(refused.status).toBe(404);
  });
});

describe('browsing a share that is one file', () => {
  const openFileShare = async (body = {}) => {
    const { user, label } = await makeOwner({ 'photo.png': 'pas vraiment une image' });
    const share = await createShare(user, {
      sourcePath: `${label}/photo.png`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      ...body,
    });
    const agent = request.agent(visitor());
    await agent.get(`/api/share/${share.shareToken}/access`);
    return { agent, share, user };
  };

  it('answers with the one file, and says it is not a folder', async () => {
    const { agent, share } = await openFileShare();

    const listing = await agent.get(`/api/share/${share.shareToken}/browse/`);

    expect(listing.status).toBe(200);
    expect(listing.body.items).toHaveLength(1);
    expect(listing.body.items[0].name).toBe('photo.png');
    expect(listing.body.current.isDirectory).toBe(false);
  });

  /**
   * A file share is a file, so the things a folder allows are refused whatever
   * the share's own access mode says: there is nowhere to upload to, nothing to
   * create, and a link is not a right to hand out more links.
   */
  it('offers none of the things a folder would', async () => {
    const { agent, share } = await openFileShare({ accessMode: 'readwrite' });

    const listing = await agent.get(`/api/share/${share.shareToken}/browse/`);

    expect(listing.body.access).toMatchObject({
      canUpload: false,
      canCreateFolder: false,
      canCreateFile: false,
      canShare: false,
    });
  });

  it('follows the share on whether the file may be downloaded', async () => {
    const { agent, share } = await openFileShare({ allowDownload: false });

    const listing = await agent.get(`/api/share/${share.shareToken}/browse/`);

    expect(listing.body.access.canDownload).toBe(false);
  });

  it('names the folder the file came from, for the breadcrumb', async () => {
    const { user, label } = await makeOwner({ 'Rapports/mars.txt': 'bonjour' });
    const share = await createShare(user, {
      sourcePath: `${label}/Rapports/mars.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      label: 'Le rapport de mars',
    });
    const agent = request.agent(visitor());
    await agent.get(`/api/share/${share.shareToken}/access`);

    const listing = await agent.get(`/api/share/${share.shareToken}/browse/`);

    expect(listing.body.shareInfo).toEqual({
      label: 'Le rapport de mars',
      sourceFolderName: 'mars.txt',
    });
  });

  it('is refused to a visitor who has not opened the link', async () => {
    const { user, label } = await makeOwner();
    const share = await createShare(user, {
      sourcePath: `${label}/hello.txt`,
      accessMode: 'readonly',
      sharingType: 'anyone',
      password: 'ouvre-toi',
    });

    const refused = await request(visitor()).get(`/api/share/${share.shareToken}/browse/`);

    expect(refused.status).toBe(401);
  });
});
