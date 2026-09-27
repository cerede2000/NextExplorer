import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A selection taken away as separate files rather than as one archive (#487).
 *
 * The browser fetches one part per file, so everything that used to happen once
 * per request would happen once per file: a public link downloaded as eleven
 * files would have read eleven downloads. The plan is where the selection is
 * counted, and the parts are where it is not — and a part still asks the
 * filesystem for permission every time, because a plan records what was asked
 * and never carries the answer forward.
 */

let envContext;

const seed = async () => {
  envContext = await setupTestEnv({
    tag: 'download-plan-',
    modules: [
      'src/routes/files/download',
      'src/services/sharesService',
      'src/services/downloadPlans',
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
  await fs.mkdir(path.join(folder, 'Photos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'rapport.txt'), 'le rapport');
  await fs.writeFile(path.join(folder, 'notes.txt'), 'les notes');
  await fs.writeFile(path.join(folder, 'Photos', 'notes.txt'), 'les autres notes');
  await fs.writeFile(path.join(folder, 'Photos', 'vue.jpg'), 'des pixels');

  const shares = envContext.requireFresh('src/services/sharesService');
  const share = await shares.createShare({
    ownerId: 'u1',
    sourceSpace: 'volume',
    sourcePath: 'Partage',
    isDirectory: true,
    accessMode: 'readonly',
    sharingType: 'anyone',
  });
  return { share, db, shares };
};

/** A visitor of the public link, with the guest session a typed password buys. */
const asVisitor = (share, sessionId = 'guest-1') => {
  const downloadRoutes = envContext.requireFresh('src/routes/files/download');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.guestSession = { id: sessionId, shareId: share.id };
    next();
  });
  app.use('/api/files', downloadRoutes);
  app.use(errorHandler);
  return app;
};

const counters = (db, shareId) =>
  db.prepare('SELECT download_count FROM shares WHERE id = ?').get(shareId);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a selection asked for as separate files', () => {
  it('counts one download for the whole selection, parts included', async () => {
    const { share, db } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/files/download/plan')
      .send({
        paths: [`${root}/rapport.txt`, `${root}/notes.txt`, `${root}/Photos`],
        basePath: root,
      });
    expect(plan.status).toBe(200);
    expect(plan.body.files).toHaveLength(2);
    expect(plan.body.archive).toMatchObject({ folders: 1 });
    expect(counters(db, share.id).download_count).toBe(1);

    for (const file of plan.body.files) {
      const part = await request(app).get(
        `/api/files/download/part/${plan.body.token}/${file.index}`
      );
      expect(part.status).toBe(200);
      expect(part.headers['content-disposition']).toContain(file.name);
    }

    const archive = await request(app).get(`/api/files/download/part/${plan.body.token}/archive`);
    expect(archive.status).toBe(200);
    expect(archive.headers['content-type']).toContain('zip');

    // Three parts fetched, one download read: the gesture, not the requests.
    expect(counters(db, share.id).download_count).toBe(1);
  });

  it('answers the bytes of the file at that position', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/files/download/plan')
      .send({ paths: [`${root}/rapport.txt`], basePath: root });
    expect(plan.status).toBe(200);

    const part = await request(app).get(`/api/files/download/part/${plan.body.token}/0`);
    expect(part.status).toBe(200);
    expect(part.text).toBe('le rapport');
  });

  it('gives two files of the same name two names', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/files/download/plan')
      .send({ paths: [`${root}/notes.txt`, `${root}/Photos/notes.txt`], basePath: root });
    expect(plan.status).toBe(200);

    const names = plan.body.files.map(({ name }) => name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('notes.txt');
    expect(names.some((name) => /^notes \(1\)\.txt$/.test(name))).toBe(true);
  });

  it('asks again for permission when a part is fetched', async () => {
    const { share, shares } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/files/download/plan')
      .send({ paths: [`${root}/rapport.txt`], basePath: root });
    expect(plan.status).toBe(200);

    // The link is withdrawn between the plan and the part. A plan that carried
    // its own permission would hand the file over anyway.
    await shares.deleteShare(share.id, 'u1');

    const part = await request(app).get(`/api/files/download/part/${plan.body.token}/0`);
    expect(part.status).toBeGreaterThanOrEqual(400);
    expect(part.status).toBeLessThan(500);
  });

  it('refuses a token to anybody but the requester who made it', async () => {
    const { share } = await seed();
    const root = `share/${share.shareToken}`;

    const plan = await request(asVisitor(share, 'guest-1'))
      .post('/api/files/download/plan')
      .send({ paths: [`${root}/rapport.txt`], basePath: root });
    expect(plan.status).toBe(200);

    const stolen = await request(asVisitor(share, 'guest-2')).get(
      `/api/files/download/part/${plan.body.token}/0`
    );
    expect(stolen.status).toBe(404);
  });

  it('refuses a part nobody planned', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/files/download/plan')
      .send({ paths: [`${root}/rapport.txt`], basePath: root });
    expect(plan.status).toBe(200);

    expect((await request(app).get('/api/files/download/part/nope/0')).status).toBe(404);
    expect((await request(app).get(`/api/files/download/part/${plan.body.token}/7`)).status).toBe(
      404
    );
    expect(
      (await request(app).get(`/api/files/download/part/${plan.body.token}/archive`)).status
    ).toBe(404);
  });
});
