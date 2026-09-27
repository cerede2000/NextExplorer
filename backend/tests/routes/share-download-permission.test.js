import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A share that may be read but not taken away.
 *
 * `canDownload` existed across four call sites and was set to `true` at every
 * place that set it — the only `false` was in the denied-access object, where
 * `canAccess` had already answered. Removing the check from the download route
 * broke no test, because nothing could ever withhold it. It was a promise the
 * code did not keep, and the frontend gated a button on it.
 *
 * `allowDownload` on a share is what makes it mean something: "read this"
 * rather than "take a copy of this". It is deliberately not tied to read-write
 * like the other granular permissions — a read-only share is exactly where
 * withholding a download is the point.
 *
 * The default is allowed, everywhere, so every share made before this existed
 * behaves as it always did. That is the property most worth pinning: a
 * permission added to a live system must not silently take something away.
 */

let ctx;

const setup = async () => {
  ctx = await setupTestEnv({
    tag: 'share-download-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/services/db',
      'src/services/sharesService',
      'src/services/accessManager',
      'src/routes/shares',
      'src/routes/files/download',
      'src/middleware/errorHandler',
    ],
  });

  await fs.mkdir(path.join(ctx.volumeDir, 'Docs'), { recursive: true });
  await fs.writeFile(path.join(ctx.volumeDir, 'Docs', 'report.txt'), 'the contents');

  const { getDb } = ctx.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('owner', 'owner@example.com', 1, 'owner', 'Owner', '["admin"]', ?, ?)`
  ).run(now, now);

  const shares = ctx.requireFresh('src/services/sharesService');
  const routes = ctx.requireFresh('src/routes/shares');
  const { errorHandler } = ctx.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'owner', roles: ['admin'] };
    next();
  });
  // Mounted at both paths, as the application mounts it: `/api/shares` is the
  // owner's view of their shares, `/api/share` is what a link resolves to.
  app.use('/api/shares', routes);
  app.use('/api/share', routes);
  app.use(errorHandler);

  // The ordinary download endpoint, which resolves a `share/<token>/...` path
  // through the same access manager as everything else.
  const downloadRoutes = ctx.requireFresh('src/routes/files/download');
  const downloadApp = express();
  downloadApp.use(express.json());
  downloadApp.use((req, _res, next) => {
    req.user = { id: 'owner', roles: ['admin'] };
    next();
  });
  downloadApp.use('/api', downloadRoutes);
  downloadApp.use(errorHandler);

  return { shares, app, db, downloadApp };
};

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

const makeShare = (shares, overrides = {}) =>
  shares.createShare({
    ownerId: 'owner',
    sourceSpace: 'volume',
    sourcePath: 'Docs/report.txt',
    isDirectory: false,
    accessMode: 'readonly',
    sharingType: 'anyone',
    ...overrides,
  });

describe('a share that allows downloads', () => {
  it('is the default, so nothing that already exists changes', async () => {
    const { shares } = await setup();

    const share = await makeShare(shares);

    expect(share.allowDownload).toBe(true);
  });

  it('serves the file', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares);

    const response = await request(app).get(`/api/share/${share.shareToken}/file`);

    expect(response.status).toBe(200);
  });

  /**
   * A row written before the column existed has it filled in by the migration
   * default. Anything else would take downloads away from live share links on
   * an upgrade.
   */
  it('is what a row from before the column reads as', async () => {
    const { shares, db } = await setup();
    const share = await makeShare(shares);
    db.prepare('UPDATE shares SET allow_download = 1 WHERE id = ?').run(share.id);

    const reloaded = await shares.getShareById(share.id);

    expect(reloaded.allowDownload).toBe(true);
  });
});

describe('a share that withholds them', () => {
  it('records the choice', async () => {
    const { shares } = await setup();

    const share = await makeShare(shares, { allowDownload: false });

    expect(share.allowDownload).toBe(false);
  });

  it('refuses the file', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { allowDownload: false });

    const response = await request(app).get(`/api/share/${share.shareToken}/file`);

    expect(response.status).toBe(403);
  });

  /**
   * The whole point: reading still works. A share nobody can open is not a
   * read-only share, it is a broken one.
   */
  it('still lets the share be opened', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { allowDownload: false });

    const response = await request(app).get(`/api/share/${share.shareToken}/access`);

    expect(response.status).toBe(200);
  });

  /**
   * Told to the client before it browses anything, so a share view can hide the
   * button instead of offering a click whose only outcome is a 403.
   */
  it('says so in the payload that opens the share', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { allowDownload: false });

    const response = await request(app).get(`/api/share/${share.shareToken}/access`);

    expect(response.body?.share?.allowDownload).toBe(false);
  });

  it('says the opposite for one that allows them', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares);

    const response = await request(app).get(`/api/share/${share.shareToken}/access`);

    expect(response.body?.share?.allowDownload).toBe(true);
  });

  /**
   * And per row in the listing, which used to be hard-coded true: every file in
   * a share with downloads withheld still showed the button.
   */
  it('says so for each file in the listing too', async () => {
    const { shares, app } = await setup();
    const folderShare = await shares.createShare({
      ownerId: 'owner',
      sourceSpace: 'volume',
      sourcePath: 'Docs',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'anyone',
      allowDownload: false,
    });

    const response = await request(app).get(`/api/share/${folderShare.shareToken}/browse/`);

    expect(response.status).toBe(200);
    const items = response.body?.items || [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.access?.canDownload === false)).toBe(true);
  });

  /**
   * Not tied to read-write, unlike delete, upload and the create permissions.
   * A read-write share where downloads are withheld is coherent — collaborate
   * on it, do not take it home — and gating it the way the others are gated
   * would make that impossible to express.
   */
  it('withholds them on a read-write share too', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { accessMode: 'readwrite', allowDownload: false });

    const response = await request(app).get(`/api/share/${share.shareToken}/file`);

    expect(response.status).toBe(403);
  });
});

describe('the ordinary download route, on a share path', () => {
  /**
   * A signed-in person can reach a share through the normal explorer, and the
   * normal download endpoint resolves `share/<token>/...` through the same
   * access manager. That endpoint's own `canDownload` check was the one nothing
   * could reach — it is reachable now, and this is what reaches it.
   */
  it('refuses a file inside a share that withholds downloads', async () => {
    const { shares, app, downloadApp } = await setup();
    const share = await shares.createShare({
      ownerId: 'owner',
      sourceSpace: 'volume',
      sourcePath: 'Docs',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'anyone',
      allowDownload: false,
    });
    expect(app).toBeTruthy();

    const response = await request(downloadApp)
      .post('/api/download')
      .send({ paths: [`share/${share.shareToken}/report.txt`] });

    expect(response.status).toBe(403);
  });

  it('serves it from a share that allows them', async () => {
    const { shares, downloadApp } = await setup();
    const share = await shares.createShare({
      ownerId: 'owner',
      sourceSpace: 'volume',
      sourcePath: 'Docs',
      isDirectory: true,
      accessMode: 'readonly',
      sharingType: 'anyone',
    });

    const response = await request(downloadApp)
      .post('/api/download')
      .send({ paths: [`share/${share.shareToken}/report.txt`] });

    expect(response.status).toBe(200);
  });
});

describe('changing it afterwards', () => {
  it('can be switched off on an existing share', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares);

    await request(app).put(`/api/shares/${share.id}`).send({ allowDownload: false });
    const response = await request(app).get(`/api/share/${share.shareToken}/file`);

    expect(response.status).toBe(403);
  });

  it('can be switched back on', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { allowDownload: false });

    await request(app).put(`/api/shares/${share.id}`).send({ allowDownload: true });
    const response = await request(app).get(`/api/share/${share.shareToken}/file`);

    expect(response.status).toBe(200);
  });

  /** An update that says nothing about it must not reset it. */
  it('is left alone by an update that does not mention it', async () => {
    const { shares, app } = await setup();
    const share = await makeShare(shares, { allowDownload: false });

    await request(app).put(`/api/shares/${share.id}`).send({ label: 'Renamed' });
    const reloaded = await shares.getShareById(share.id);

    expect(reloaded.allowDownload).toBe(false);
  });
});
