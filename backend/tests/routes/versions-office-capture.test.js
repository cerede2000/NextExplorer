import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What an office editor's saves leave in a document's history.
 *
 * ONLYOFFICE and Collabora save on their own every few seconds while someone
 * types. Kept one by one, those saves would fill a volume with near copies of
 * the same document — which is what Nextcloud does with Collabora's. What is
 * kept is the document as it was before the session, a save someone asked for,
 * and the state a previous session left; and a save from an editor that was
 * open before a restore never undoes it.
 */

const ONLYOFFICE_SECRET = 'onlyoffice-versions-secret';
const COLLABORA_SECRET = 'collabora-versions-secret';

let env;
let documentServer;
let port;
const served = new Map();

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  served.clear();
  documentServer = http.createServer((req, res) => {
    if (!served.has(req.url)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(served.get(req.url));
  });
  await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
  port = documentServer.address().port;

  env = await setupTestEnv({
    tag: 'versions-office-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      ONLYOFFICE_URL: `http://127.0.0.1:${port}`,
      ONLYOFFICE_SECRET,
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET,
    },
  });
  await fs.mkdir(path.join(env.volumeDir, 'Projects'), { recursive: true });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => documentServer.close(resolve));
  await env.cleanup();
});

const volume = (...segments) => path.join(env.volumeDir, ...segments);

/** A document's versions, newest first, with what each one holds. */
const versionsOf = async (relative) => {
  const db = await load('src/services/db').getDb();
  const zones = load('src/services/trash/zones');
  const trashStore = load('src/services/trash/store');
  const store = load('src/services/versions/store');
  const [volumeName, ...inside] = relative.split('/');
  const zone = trashStore.listZones(db).find((candidate) => candidate.root === volume(volumeName));
  const file = zone ? store.findFileAt(db, zone.id, inside.join('/')) : null;
  if (!file) return [];
  return Promise.all(
    store.listVersionsOfFile(db, file.id).map(async (version) => ({
      ...version,
      content: await fs.readFile(path.join(zones.versionsDirectory(zone.root), version.id), 'utf8'),
    }))
  );
};

const markRestored = async (relative, restoredAt) => {
  const db = await load('src/services/db').getDb();
  const trashStore = load('src/services/trash/store');
  const store = load('src/services/versions/store');
  const [volumeName, ...inside] = relative.split('/');
  const zone = trashStore.listZones(db).find((candidate) => candidate.root === volume(volumeName));
  const file = store.findFileAt(db, zone.id, inside.join('/'));
  store.setRestoredAt(db, file.id, restoredAt);
};

describe('ONLYOFFICE saves', () => {
  const app = () =>
    createTestApp({
      router: load('src/routes/onlyoffice'),
      mountPath: '/api',
      user: { id: 'user-1', username: 'alice', roles: ['admin'] },
      errorHandler: load('src/middleware/errorHandler').errorHandler,
    });

  let counter = 0;
  const save = async (application, relative, content, body = {}, query = '') => {
    counter += 1;
    const url = `/document-${counter}.docx`;
    served.set(url, content);
    const response = await request(application)
      .post(`/api/onlyoffice/callback?path=${encodeURIComponent(relative)}${query}`)
      .set('Authorization', `Bearer ${jwt.sign({ callback: true }, ONLYOFFICE_SECRET)}`)
      .send({
        status: 6,
        forcesavetype: 0,
        key: 'session-1',
        url: `http://127.0.0.1:${port}${url}`,
        ...body,
      });
    expect(response.body).toEqual({ error: 0 });
    return response;
  };

  it('keeps the document as it was before the session, and not every automatic save', async () => {
    await fs.writeFile(volume('Projects/offer.docx'), 'before');
    const application = app();

    await save(application, 'Projects/offer.docx', 'autosave one');
    await save(application, 'Projects/offer.docx', 'autosave two');
    await save(application, 'Projects/offer.docx', 'autosave three');

    expect(await fs.readFile(volume('Projects/offer.docx'), 'utf8')).toBe('autosave three');
    expect((await versionsOf('Projects/offer.docx')).map((version) => version.content)).toEqual([
      'before',
    ]);
  });

  it('keeps what the editor’s own Save button saved once the session saves over it', async () => {
    await fs.writeFile(volume('Projects/offer.docx'), 'before');
    const application = app();

    await save(application, 'Projects/offer.docx', 'typing');
    await save(application, 'Projects/offer.docx', 'saved on purpose', { forcesavetype: 1 });
    await save(application, 'Projects/offer.docx', 'typing again');

    expect((await versionsOf('Projects/offer.docx')).map((version) => version.content)).toEqual([
      'saved on purpose',
      'before',
    ]);
  });

  it('keeps the state a finished session left, credited to whoever made the last change', async () => {
    await fs.writeFile(volume('Projects/offer.docx'), 'before');
    const application = app();

    await save(application, 'Projects/offer.docx', 'final by bob', {
      status: 2,
      key: 'monday',
      history: { changes: [{ user: { id: 'user-2', name: 'Bob' } }] },
    });
    await save(application, 'Projects/offer.docx', 'tuesday', { key: 'tuesday' });

    const [newest, oldest] = await versionsOf('Projects/offer.docx');
    expect(newest).toMatchObject({
      content: 'final by bob',
      authorId: 'user-2',
      authorLabel: 'Bob',
      source: 'onlyoffice',
    });
    expect(oldest.content).toBe('before');
  });

  it('sets aside a save from an editor opened before the document was restored', async () => {
    await fs.writeFile(volume('Projects/offer.docx'), 'before');
    const application = app();
    await save(application, 'Projects/offer.docx', 'restored', {
      key: 'new-session',
      forcesavetype: 1,
    });
    await markRestored('Projects/offer.docx', new Date().toISOString());
    const backend = jwt.sign(
      {
        typ: 'nextexplorer-backend',
        absolutePath: volume('Projects/offer.docx'),
        logicalPath: 'Projects/offer.docx',
        canWrite: true,
        userId: 'user-3',
        iat: Math.floor(Date.now() / 1000) - 120,
      },
      ONLYOFFICE_SECRET
    );

    await save(
      application,
      'Projects/offer.docx',
      'stale editor content',
      { key: 'old-session' },
      `&backend=${encodeURIComponent(backend)}`
    );

    expect(await fs.readFile(volume('Projects/offer.docx'), 'utf8')).toBe('restored');
    const [aside] = await versionsOf('Projects/offer.docx');
    expect(aside).toMatchObject({
      content: 'stale editor content',
      aside: true,
      authorId: 'user-3',
    });
  });

  it('leaves the document whole when the download fails half way', async () => {
    await fs.writeFile(volume('Projects/offer.docx'), 'before');
    const application = app();

    const response = await request(application)
      .post('/api/onlyoffice/callback?path=Projects%2Foffer.docx')
      .set('Authorization', `Bearer ${jwt.sign({ callback: true }, ONLYOFFICE_SECRET)}`)
      .send({ status: 6, key: 'k', url: `http://127.0.0.1:${port}/missing.docx` });

    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(volume('Projects/offer.docx'), 'utf8')).toBe('before');
    expect((await fs.readdir(volume('Projects'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    );
  });
});

describe('Collabora saves', () => {
  const app = () =>
    createTestApp({
      router: load('src/routes/collabora'),
      mountPath: '/api',
      errorHandler: load('src/middleware/errorHandler').errorHandler,
    });

  const token = (extra = {}) =>
    jwt.sign(
      {
        typ: 'nextexplorer-wopi',
        fileId: 'file-1',
        absolutePath: volume('Projects/plan.odt'),
        canWrite: true,
        userId: 'user-1',
        userName: 'Alice',
        ...extra,
      },
      COLLABORA_SECRET
    );

  const put = (
    application,
    content,
    { lock = 'lock-1', autosave = true, accessToken = token() } = {}
  ) =>
    request(application)
      .post('/api/collabora/wopi/files/file-1/contents')
      .query({ access_token: accessToken })
      .set('Content-Type', 'application/octet-stream')
      .set('X-WOPI-Lock', lock)
      .set('X-COOL-WOPI-IsAutosave', autosave ? 'true' : 'false')
      .send(Buffer.from(content));

  it('keeps the document as it was before the session, and not every automatic save', async () => {
    await fs.writeFile(volume('Projects/plan.odt'), 'before');
    const application = app();

    for (const content of ['autosave one', 'autosave two', 'autosave three']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await put(application, content)).status).toBe(200);
    }

    expect(await fs.readFile(volume('Projects/plan.odt'), 'utf8')).toBe('autosave three');
    expect((await versionsOf('Projects/plan.odt')).map((version) => version.content)).toEqual([
      'before',
    ]);
  });

  it('keeps a save someone asked for once the session saves over it', async () => {
    await fs.writeFile(volume('Projects/plan.odt'), 'before');
    const application = app();

    await put(application, 'typing');
    await put(application, 'saved on purpose', { autosave: false });
    await put(application, 'typing again');

    expect((await versionsOf('Projects/plan.odt')).map((version) => version.content)).toEqual([
      'saved on purpose',
      'before',
    ]);
  });

  it('credits the state a session left to whoever was editing, for the next session', async () => {
    await fs.writeFile(volume('Projects/plan.odt'), 'before');
    const application = app();

    await put(application, 'alice was here', { lock: 'monday' });
    await put(application, 'bob now', {
      lock: 'tuesday',
      accessToken: token({ userId: 'user-2', userName: 'Bob' }),
    });

    const [newest] = await versionsOf('Projects/plan.odt');
    expect(newest).toMatchObject({
      content: 'alice was here',
      authorId: 'user-1',
      authorLabel: 'Alice',
      source: 'collabora',
    });
  });

  it('sets aside a save from a session opened before the document was restored', async () => {
    await fs.writeFile(volume('Projects/plan.odt'), 'before');
    const application = app();
    await put(application, 'restored', { autosave: false });
    await markRestored('Projects/plan.odt', new Date().toISOString());

    const response = await put(application, 'stale', {
      lock: 'old',
      accessToken: token({ iat: Math.floor(Date.now() / 1000) - 300 }),
    });

    expect(response.status).toBe(200);
    expect(await fs.readFile(volume('Projects/plan.odt'), 'utf8')).toBe('restored');
    expect((await versionsOf('Projects/plan.odt'))[0]).toMatchObject({
      content: 'stale',
      aside: true,
    });
  });
});
