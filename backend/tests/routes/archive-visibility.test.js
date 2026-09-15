import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What an archive of a folder may hold.
 *
 * A folder handed to the archiver whole took everything under it. That
 * included the `.nextexplorer` zone — other people's deleted files and every
 * earlier version of every file — and the paths an access rule hides from
 * whoever asked. A download is a read: it may take exactly what a listing of
 * that folder shows, whether it arrives as a zip in the browser, through a
 * share link, or as an archive written next to the folder.
 *
 * And an archive written into a folder the caller can reach is a copy they can
 * take away, so a share that withholds downloads withholds that as well.
 */

let ctx;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  ctx = null;
});

const ADMIN = { id: 'admin', roles: ['admin'] };

const seed = async () => {
  ctx = await setupTestEnv({ tag: 'archive-visibility-', env: { SHARES_ENABLED: 'true' } });
  const volume = ctx.volumeDir;
  const write = async (relative, content) => {
    const target = path.join(volume, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  await write('Projects/report.txt', 'the report');
  await write('Projects/notes/today.md', '# today');
  await write('Projects/Secret/plan.txt', 'the plan');
  // What the trash and the versions keep, in the zone at the folder's root.
  await write('Projects/.nextexplorer/trash/0001/deleted.txt', 'somebody deleted this');
  await write('Projects/.nextexplorer/versions/0002', 'an earlier version');
  await write('Projects/_users/alice/private.txt', 'alice only');
  await fs.mkdir(path.join(volume, 'Out'), { recursive: true });

  const db = await ctx.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);
  return volume;
};

const hideSecret = () =>
  ctx
    .requireFresh('src/services/accessControlService')
    .setRules([{ path: 'Projects/Secret', recursive: true, permissions: 'hidden' }]);

const buildApp = (user = ADMIN) => {
  const { errorHandler } = ctx.requireFresh('src/middleware/errorHandler');
  const shares = ctx.requireFresh('src/routes/shares');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', ctx.requireFresh('src/routes/files/download'));
  app.use('/api', ctx.requireFresh('src/routes/zip'));
  app.use('/api/shares', shares);
  app.use('/api/share', shares);
  app.use(errorHandler);
  return app;
};

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const entriesOf = (zipBuffer) =>
  new AdmZip(zipBuffer)
    .getEntries()
    .map((entry) => entry.entryName)
    .sort();

const downloadZip = async (app, body) => {
  const response = await request(app).post('/api/download').send(body).buffer(true).parse(binary);
  expect(response.status).toBe(200);
  return entriesOf(response.body);
};

const compress = async (app, body) =>
  request(app).post('/api/files/zip/compress').send(body).buffer(true);

const lastEvent = (response) =>
  String(response.text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .at(-1);

describe('a folder downloaded as a zip', () => {
  it('holds what the folder shows, and not the trash zone or the personal folders', async () => {
    await seed();

    const entries = await downloadZip(buildApp(), { paths: ['Projects'] });

    expect(entries).toEqual(
      expect.arrayContaining([
        'Projects/report.txt',
        'Projects/notes/today.md',
        'Projects/Secret/plan.txt',
      ])
    );
    expect(entries.filter((name) => name.includes('.nextexplorer'))).toEqual([]);
    expect(entries.filter((name) => name.includes('_users'))).toEqual([]);
  });

  it('leaves out a path an access rule hides', async () => {
    await seed();
    await hideSecret();

    const entries = await downloadZip(buildApp(), { paths: ['Projects'] });

    expect(entries).toContain('Projects/report.txt');
    expect(entries.filter((name) => name.includes('Secret'))).toEqual([]);
  });

  it('leaves them out of each folder of a selection too', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Projects', 'more', '.nextexplorer'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Projects', 'more', '.nextexplorer', 'x'), 'zone');
    await fs.writeFile(path.join(volume, 'Projects', 'more', 'keep.txt'), 'keep');

    const entries = await downloadZip(buildApp(), {
      paths: ['Projects/more', 'Projects/report.txt'],
      basePath: 'Projects',
    });

    expect(entries).toEqual(expect.arrayContaining(['more/keep.txt', 'report.txt']));
    expect(entries.filter((name) => name.includes('.nextexplorer'))).toEqual([]);
  });
});

describe('a shared folder downloaded through its link', () => {
  it('holds what the share shows, and not the trash zone or a hidden path', async () => {
    await seed();
    await hideSecret();
    const created = await request(buildApp())
      .post('/api/shares')
      .send({ sourcePath: 'Projects', sharingType: 'anyone' });
    expect(created.status).toBe(201);

    // Somebody with the link and no account.
    const response = await request(buildApp(null))
      .get(`/api/share/${created.body.shareToken}/file`)
      .buffer(true)
      .parse(binary);

    expect(response.status).toBe(200);
    const entries = entriesOf(response.body);
    expect(entries).toContain('Projects/report.txt');
    expect(entries.filter((name) => name.includes('.nextexplorer'))).toEqual([]);
    expect(entries.filter((name) => name.includes('Secret'))).toEqual([]);
  });
});

describe('an archive written next to the folder', () => {
  it('holds what the folder shows, and not the trash zone or a hidden path', async () => {
    const volume = await seed();
    await hideSecret();

    const response = await compress(buildApp(), {
      items: [{ name: 'Projects', path: '' }],
      destination: 'Out',
      name: 'projects',
    });

    expect(response.status).toBe(200);
    expect(lastEvent(response)).toMatchObject({ type: 'done', item: { name: 'projects.zip' } });
    const entries = entriesOf(await fs.readFile(path.join(volume, 'Out', 'projects.zip')));
    expect(entries).toEqual(
      expect.arrayContaining(['Projects/report.txt', 'Projects/notes/today.md'])
    );
    expect(entries.filter((name) => name.includes('.nextexplorer'))).toEqual([]);
    expect(entries.filter((name) => name.includes('_users'))).toEqual([]);
    expect(entries.filter((name) => name.includes('Secret'))).toEqual([]);
  });

  it('is refused from a share that withholds downloads, and says why', async () => {
    const volume = await seed();
    const created = await request(buildApp())
      .post('/api/shares')
      .send({ sourcePath: 'Projects', sharingType: 'anyone', allowDownload: false });
    expect(created.status).toBe(201);

    const response = await compress(buildApp(), {
      items: [{ name: 'report.txt', path: `share/${created.body.shareToken}` }],
      destination: 'Out',
      name: 'taken',
    });

    expect(response.status).toBe(403);
    expect(response.body?.error?.message || response.text).toMatch(/downloading is not allowed/i);
    expect(await fs.readdir(path.join(volume, 'Out'))).toEqual([]);
  });
});
