import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A document's history, inside the office editors.
 *
 * ONLYOFFICE is handed the history and then, version by version, a URL to fetch
 * each one from; Collabora is handed an earlier version to open on its own.
 * Either way the Document Server or the WOPI client fetches content on its own,
 * with no session of ours: the token in the URL is all that decides what goes
 * out. So these check that it names the version and nothing else, that nothing
 * can be written through it, and that a share whose owner keeps the history
 * hidden hands none of it out.
 */

const ONLYOFFICE_SECRET = 'office-versions-secret';
const COLLABORA_SECRET = 'office-versions-collabora-secret';
const DOCUMENT = 'Projects/report.docx';

const DISCOVERY = `<wopi-discovery><net-zone name="external-https"><app name="writer">
<action default="true" ext="docx" name="edit" urlsrc="https://collabora.example.com/browser/dist/cool.html?"/>
<action ext="docx" name="view" urlsrc="https://collabora.example.com/browser/dist/cool.html?"/>
</app></net-zone></wopi-discovery>`;

let env;
let users;
let app;
let discovery;
let documentServer;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  // Stands in for both servers: Collabora's discovery, and a Document Server
  // with a saved document ready to be fetched — so that a save refused is
  // refused, not merely unable to download.
  discovery = http.createServer((req, res) => {
    if (req.url === '/saved.docx') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end('overwritten');
      return;
    }
    res.setHeader('Content-Type', 'text/xml');
    res.end(DISCOVERY);
  });
  await new Promise((resolve) => discovery.listen(0, '127.0.0.1', resolve));
  documentServer = `http://127.0.0.1:${discovery.address().port}`;

  env = await setupTestEnv({
    tag: 'office-versions-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      SHARES_ENABLED: 'true',
      ONLYOFFICE_URL: documentServer,
      ONLYOFFICE_SECRET,
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET,
      COLLABORA_DISCOVERY_URL: `${documentServer}/hosting/discovery`,
    },
  });
  users = {
    alice: await load('src/services/users').createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'secret123',
      roles: ['user'],
    }),
  };
  await fs.mkdir(path.join(env.volumeDir, 'Projects'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who?.startsWith('guest:')) {
      req.guestSession = { id: 'guest-session', shareId: who.slice('guest:'.length) };
    } else if (who) {
      req.user = users[who];
    }
    next();
  });
  app.use('/api', load('src/routes/onlyoffice'));
  app.use('/api', load('src/routes/collabora'));
  app.use('/api/shares', load('src/routes/shares'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => discovery.close(resolve));
  await env.cleanup();
});

const absolute = (relative) => path.join(env.volumeDir, ...relative.split('/'));

/** A document saved over twice: two versions, "first" then "second", and "third" now. */
const withHistory = async (relative = DOCUMENT) => {
  const target = absolute(relative);
  await fs.writeFile(target, 'first');
  for (const content of ['second', 'third']) {
    await load('src/services/versions/operations').saveFile(
      target,
      (temporaryPath) => fs.writeFile(temporaryPath, content),
      {
        purpose: 'test',
        author: { id: users.alice.id, label: 'Alice' },
        source: 'editor',
        explicit: true,
      }
    );
  }
};

const post = (url, body, who = 'alice') => {
  const call = request(app).post(url).send(body);
  return who ? call.set('x-test-user', who) : call;
};

/**
 * A document goes out with its own content type, which supertest does not
 * buffer: the body is collected by hand, or the test compares nothing.
 */
const collectBody = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
};

/** What the Document Server gets when it fetches a URL it was handed: no session, its own token. */
const fetchAsDocumentServer = (absoluteUrl) => {
  const url = new URL(absoluteUrl);
  return request(app)
    .get(`${url.pathname}${url.search}`)
    .set('Authorization', `Bearer ${jwt.sign({ any: true }, ONLYOFFICE_SECRET)}`)
    .buffer(true)
    .parse(collectBody);
};

describe('the history ONLYOFFICE shows', () => {
  it('lists the versions oldest first, and the document as it is last, under its open key', async () => {
    await withHistory();
    const opened = await post('/api/onlyoffice/config', { path: DOCUMENT });
    expect(opened.status).toBe(200);

    const response = await post('/api/onlyoffice/history', { path: DOCUMENT });

    expect(response.status).toBe(200);
    const { history, currentVersion, canRestore } = response.body;
    expect(currentVersion).toBe(3);
    expect(history.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(history[2]).toMatchObject({ versionId: null, key: opened.body.config.document.key });
    expect(history[0].key).toBe(`version-${history[0].versionId}`);
    expect(new Set(history.map((entry) => entry.key)).size).toBe(3);
    // "first" was written outside the app, so nobody is known to have written it;
    // "second" was Alice's save.
    expect(history[0].user).toEqual({ id: '', name: '' });
    expect(history[1].user).toEqual({ id: users.alice.id, name: 'Alice' });
    expect(canRestore).toBe(true);
  });

  it('hands each version over signed, at a URL that serves that version', async () => {
    await withHistory();
    const { history } = (await post('/api/onlyoffice/history', { path: DOCUMENT })).body;

    const oldest = await post('/api/onlyoffice/history-data', {
      path: DOCUMENT,
      version: 1,
      versionId: history[0].versionId,
    });
    const middle = await post('/api/onlyoffice/history-data', {
      path: DOCUMENT,
      version: 2,
      versionId: history[1].versionId,
    });
    const current = await post('/api/onlyoffice/history-data', { path: DOCUMENT, version: 3 });

    expect(oldest.status).toBe(200);
    expect(oldest.body).toMatchObject({ version: 1, fileType: 'docx', key: history[0].key });
    expect(jwt.verify(oldest.body.token, ONLYOFFICE_SECRET)).toMatchObject({
      version: 1,
      fileType: 'docx',
      key: history[0].key,
      url: oldest.body.url,
    });
    expect((await fetchAsDocumentServer(oldest.body.url)).body).toBe('first');
    expect((await fetchAsDocumentServer(middle.body.url)).body).toBe('second');
    expect(current.body.key).toBe(history[2].key);
    expect((await fetchAsDocumentServer(current.body.url)).body).toBe('third');
  });

  it("refuses a version number that is not one, and another file's version", async () => {
    await withHistory();
    await withHistory('Projects/other.docx');
    const others = (await post('/api/onlyoffice/history', { path: 'Projects/other.docx' })).body;

    const noNumber = await post('/api/onlyoffice/history-data', { path: DOCUMENT, version: 0 });
    const borrowed = await post('/api/onlyoffice/history-data', {
      path: DOCUMENT,
      version: 1,
      versionId: others.history[0].versionId,
    });

    expect(noNumber.status).toBe(400);
    expect(borrowed.status).toBe(404);
  });
});

describe('an earlier version opened in ONLYOFFICE', () => {
  it('is a viewer on that version, with no callback and a key of its own', async () => {
    await withHistory();
    const { history } = (await post('/api/onlyoffice/history', { path: DOCUMENT })).body;

    const viewed = await post('/api/onlyoffice/config', {
      path: DOCUMENT,
      versionId: history[0].versionId,
    });

    expect(viewed.status).toBe(200);
    const { config } = viewed.body;
    expect(config.editorConfig.mode).toBe('view');
    expect(config.editorConfig.callbackUrl).toBeUndefined();
    expect(config.document.permissions).toMatchObject({
      edit: false,
      comment: false,
      review: false,
    });
    expect(config.document.key).toBe(history[0].key);
    expect(viewed.body.forceSaveSessionId).toBeNull();
    expect(jwt.verify(config.token, ONLYOFFICE_SECRET).document.url).toBe(config.document.url);
    expect((await fetchAsDocumentServer(config.document.url)).body).toBe('first');
  });

  it('writes nothing through its token, even when a save is sent with it', async () => {
    await withHistory();
    const { history } = (await post('/api/onlyoffice/history', { path: DOCUMENT })).body;
    const { config } = (
      await post('/api/onlyoffice/config', { path: DOCUMENT, versionId: history[0].versionId })
    ).body;
    const backend = new URL(config.document.url).searchParams.get('backend');

    // The Document Server does have a document ready: were the save allowed, it
    // would be written.
    const response = await request(app)
      .post(`/api/onlyoffice/callback?path=${encodeURIComponent(DOCUMENT)}&backend=${backend}`)
      .set('Authorization', `Bearer ${jwt.sign({ callback: true }, ONLYOFFICE_SECRET)}`)
      .send({ status: 6, key: history[0].key, url: `${documentServer}/saved.docx` });

    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(absolute(DOCUMENT), 'utf8')).toBe('third');
  });
});

describe('an earlier version opened in Collabora', () => {
  const versionIds = async () =>
    (
      await load('src/services/versions').listVersions({ user: users.alice }, DOCUMENT)
    ).versions.map((version) => version.id);

  it('is read under the file name, apart from the document, and never written', async () => {
    await withHistory();
    const [, oldestId] = await versionIds();

    const opened = await post('/api/collabora/config', { path: DOCUMENT, versionId: oldestId });
    const live = await post('/api/collabora/config', { path: DOCUMENT });

    expect(opened.status).toBe(200);
    const { accessToken, fileId } = opened.body;
    expect(fileId).not.toBe(live.body.fileId);
    expect(new URL(opened.body.urlSrc).searchParams.get('revisionhistory')).toBeNull();

    const info = await request(app)
      .get(`/api/collabora/wopi/files/${fileId}`)
      .query({ access_token: accessToken });
    expect(info.body).toMatchObject({
      BaseFileName: 'report.docx',
      UserCanWrite: false,
      UserCanNotWriteRelative: true,
    });

    const content = await request(app)
      .get(`/api/collabora/wopi/files/${fileId}/contents`)
      .query({ access_token: accessToken })
      .buffer(true)
      .parse(collectBody);
    expect(content.body).toBe('first');

    const put = await request(app)
      .post(`/api/collabora/wopi/files/${fileId}/contents`)
      .query({ access_token: accessToken })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('overwritten'));
    expect(put.status).toBe(403);
    expect(await fs.readFile(absolute(DOCUMENT), 'utf8')).toBe('third');
  });

  it('shows the Revision history entry on the document itself, where there is one', async () => {
    await withHistory();

    const live = await post('/api/collabora/config', { path: DOCUMENT });

    expect(live.status).toBe(200);
    expect(new URL(live.body.urlSrc).searchParams.get('revisionhistory')).toBe('1');
    const info = await request(app)
      .get(`/api/collabora/wopi/files/${live.body.fileId}`)
      .query({ access_token: live.body.accessToken });
    expect(info.body.BaseFileName).toBe('report.docx');
    expect(info.body.UserCanNotWriteRelative).toBeUndefined();
  });

  it('shows no Revision history entry once versions are switched off', async () => {
    await withHistory();
    await load('src/services/settingsService').setSettings({ versions: { enabled: false } });

    const live = await post('/api/collabora/config', { path: DOCUMENT });

    expect(live.status).toBe(200);
    expect(new URL(live.body.urlSrc).searchParams.get('revisionhistory')).toBeNull();
  });
});

describe('through a share', () => {
  it('hands out no history until its owner shows it', async () => {
    await withHistory();
    const { history } = (await post('/api/onlyoffice/history', { path: DOCUMENT })).body;
    const share = (await post('/api/shares', { sourcePath: 'Projects', sharingType: 'anyone' }))
      .body;
    const shared = `share/${share.shareToken}/report.docx`;
    const guest = `guest:${share.id}`;
    const versionId = history[0].versionId;

    expect((await post('/api/onlyoffice/history', { path: shared }, guest)).status).toBe(403);
    expect(
      (await post('/api/onlyoffice/history-data', { path: shared, version: 1, versionId }, guest))
        .status
    ).toBe(403);
    // Nor the document as it is, from inside a history it may not show.
    expect(
      (await post('/api/onlyoffice/history-data', { path: shared, version: 3 }, guest)).status
    ).toBe(403);
    expect((await post('/api/onlyoffice/config', { path: shared, versionId }, guest)).status).toBe(
      403
    );
    expect((await post('/api/collabora/config', { path: shared, versionId }, guest)).status).toBe(
      403
    );
    const live = await post('/api/collabora/config', { path: shared }, guest);
    expect(live.status).toBe(200);
    expect(new URL(live.body.urlSrc).searchParams.get('revisionhistory')).toBeNull();

    await request(app)
      .put(`/api/shares/${share.id}`)
      .set('x-test-user', 'alice')
      .send({ versionsVisible: true });

    const shown = await post('/api/onlyoffice/history', { path: shared }, guest);
    expect(shown.status).toBe(200);
    expect(shown.body.history).toHaveLength(3);
    // A link for anyone is read-only: seeing the history is not restoring it.
    expect(shown.body.canRestore).toBe(false);
    const reopened = await post('/api/collabora/config', { path: shared }, guest);
    expect(new URL(reopened.body.urlSrc).searchParams.get('revisionhistory')).toBe('1');
  });
});
