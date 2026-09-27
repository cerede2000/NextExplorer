import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A public link's own download count, for a fetch that came through the files
 * route rather than the share one.
 *
 * A visitor inside a shared folder who picks several files gets them as one zip
 * from `/api/files/download`, and one who opens a single file gets it from the
 * same place. Both are that link being used, and only the share route was
 * counting them — so a link whose owner watched its last-downloaded date saw
 * nothing for the way their visitors actually download.
 */

let envContext;

const seed = async () => {
  envContext = await setupTestEnv({
    tag: 'files-download-share-',
    modules: [
      'src/routes/files/download',
      'src/services/sharesService',
      'src/middleware/errorHandler',
      'src/services/accessManager',
    ],
  });
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'u1@example.com', 1, 'u1', 'U1', '["admin"]', ?, ?)`
  ).run(now, now);

  const folder = path.join(envContext.volumeDir, 'Partage');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'rapport.txt'), 'du texte');

  const shares = envContext.requireFresh('src/services/sharesService');
  const share = await shares.createShare({
    ownerId: 'u1',
    sourceSpace: 'volume',
    sourcePath: 'Partage',
    isDirectory: true,
    accessMode: 'readonly',
    sharingType: 'anyone',
  });
  return { share, db };
};

const asVisitor = (share) => {
  const downloadRoutes = envContext.requireFresh('src/routes/files/download');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.guestSession = { shareId: share.id };
    next();
  });
  app.use('/api/files', downloadRoutes);
  app.use(errorHandler);
  return app;
};

const counters = (db, shareId) =>
  db
    .prepare('SELECT download_count, last_downloaded_at, last_download_ip FROM shares WHERE id = ?')
    .get(shareId);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a file fetched from inside a public share', () => {
  it('counts against the link it was reached through', async () => {
    const { share, db } = await seed();
    expect(counters(db, share.id)).toMatchObject({
      download_count: 0,
      last_downloaded_at: null,
    });

    const response = await request(asVisitor(share))
      .post('/api/files/download')
      .send({ paths: [`share/${share.shareToken}/rapport.txt`] });
    expect(response.status).toBe(200);

    const after = counters(db, share.id);
    expect(after.download_count).toBe(1);
    expect(after.last_downloaded_at).toBeTruthy();
    expect(typeof after.last_download_ip).toBe('string');
    expect(after.last_download_ip.length).toBeGreaterThan(0);
  });
});
