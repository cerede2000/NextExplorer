import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a document offers from inside the editor.
 *
 * Three things the editor asks the integration for and got no answer to, so it
 * hid them: saving a copy, which left Download as the only way out — through
 * the browser, into the person's downloads rather than their volume; the list
 * of people a comment can mention; and the document's own history, which is
 * also the only way an earlier .docx can be put in front of anybody, since the
 * versions panel can only show text on its own.
 */

const SECRET = 'onlyoffice-inside-secret';
const DOCUMENT = 'Projects/report.docx';

let env;
let app;
let users;
let documentServer;
let serverUrl;
let stranger;
let strangerUrl;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

beforeEach(async () => {
  documentServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end('a converted document');
  });
  await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${documentServer.address().port}`;

  stranger = http.createServer((_req, res) => res.end('somewhere else entirely'));
  await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
  strangerUrl = `http://127.0.0.1:${stranger.address().port}`;

  env = await setupTestEnv({
    tag: 'onlyoffice-inside-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      ONLYOFFICE_URL: serverUrl,
      ONLYOFFICE_SECRET: SECRET,
    },
  });

  const usersService = load('src/services/users');
  const make = (name) =>
    usersService.createLocalUser({
      email: `${name}@example.com`,
      username: name,
      displayName: name[0].toUpperCase() + name.slice(1),
      password: 'secret123',
      roles: ['user'],
    });
  users = { alice: await make('alice'), bob: await make('bob') };

  await fs.mkdir(volume('Projects'), { recursive: true });
  await fs.writeFile(volume('Projects', 'report.docx'), 'first');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who === 'nobody') {
      req.guestSession = { id: 'guest-1' };
    } else {
      req.user = users[who || 'alice'];
    }
    next();
  });
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/onlyoffice'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => documentServer.close(resolve));
  await new Promise((resolve) => stranger.close(resolve));
  await env.cleanup();
});

const as = (who) => ({
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
  get: (url) => request(app).get(url).set('x-test-user', who),
});

const saveAs = (title, { url = `${serverUrl}/converted.pdf`, who = 'alice' } = {}) =>
  as(who).post('/api/onlyoffice/save-as', { path: DOCUMENT, url, title });

describe('saving a copy from the editor', () => {
  it('writes it beside the original, in the volume', async () => {
    const response = await saveAs('report.pdf');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: 'Projects/report.pdf', name: 'report.pdf' });
    expect(await fs.readFile(volume('Projects', 'report.pdf'), 'utf8')).toBe(
      'a converted document'
    );
  });

  /** Never over anything: the same "(1)" treatment as everywhere else. */
  it('takes another name rather than replacing a file', async () => {
    await fs.writeFile(volume('Projects', 'report.pdf'), 'do not lose me');

    const response = await saveAs('report.pdf');

    expect(response.body.name).not.toBe('report.pdf');
    expect(await fs.readFile(volume('Projects', 'report.pdf'), 'utf8')).toBe('do not lose me');
    expect(await fs.readFile(volume('Projects', response.body.name), 'utf8')).toBe(
      'a converted document'
    );
  });

  /**
   * Refused, not trimmed to its last segment: reinterpreting it would turn
   * "../invoice.pdf" into a silent success in a folder nobody named.
   */
  it('refuses a title that is a path', async () => {
    const response = await saveAs('../escaped.pdf');

    expect(response.status).toBe(400);
    await expect(fs.stat(volume('escaped.pdf'))).rejects.toThrow();
  });

  it('refuses a document URL that is not the Document Server', async () => {
    const response = await saveAs('report.pdf', { url: `${strangerUrl}/anything.pdf` });

    expect(response.status).toBe(403);
    await expect(fs.stat(volume('Projects', 'report.pdf'))).rejects.toThrow();
  });

  it('is refused where the folder may not be written', async () => {
    await load('src/services/accessControlService').setRules([
      { path: 'Projects', permissions: 'ro', recursive: true },
    ]);

    expect((await saveAs('report.pdf')).status).toBe(403);
  });
});

describe('who a comment can mention', () => {
  it('answers with everybody, for the editor to filter', async () => {
    const response = await as('alice').get('/api/onlyoffice/users');

    expect(response.status).toBe(200);
    expect(response.body.users.map((user) => user.email).sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  /** A visitor through a share link has no business being handed the directory. */
  it('is refused to somebody who is not signed in', async () => {
    expect((await as('nobody').get('/api/onlyoffice/users')).status).toBe(403);
  });

  it('records a mention and says plainly that nothing was sent', async () => {
    const response = await as('alice').post('/api/onlyoffice/notify', {
      path: DOCUMENT,
      emails: ['bob@example.com'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: false });
  });

  it('refuses a mention on a document the sender cannot read', async () => {
    expect((await as('nobody').post('/api/onlyoffice/notify', { path: DOCUMENT })).status).toBe(
      403
    );
  });
});

describe("a document's history inside the editor", () => {
  const withHistory = async () => {
    const save = (content) =>
      request(app).put('/api/editor').send({ path: 'Projects/notes.txt', content });
    await save('first');
    await save('second');
  };

  it('numbers the versions from the oldest and ends with the document itself', async () => {
    await withHistory();

    const response = await as('alice').post('/api/onlyoffice/history', {
      path: 'Projects/notes.txt',
    });

    expect(response.status).toBe(200);
    expect(response.body.history).toHaveLength(2);
    expect(response.body.history.map((entry) => entry.version)).toEqual([1, 2]);
    // The last entry is the current state, which has no version id of its own.
    expect(response.body.history[1].versionId).toBeNull();
    expect(response.body.currentVersion).toBe(2);
    expect(response.body.canRestore).toBe(true);
  });

  it('hands over where one entry is fetched from, signed', async () => {
    await withHistory();
    const { history } = (
      await as('alice').post('/api/onlyoffice/history', { path: 'Projects/notes.txt' })
    ).body;

    const response = await as('alice').post('/api/onlyoffice/history-data', {
      path: 'Projects/notes.txt',
      version: 1,
      versionId: history[0].versionId,
    });

    expect(response.status).toBe(200);
    expect(response.body.key).toBe(history[0].key);
    expect(() => jwt.verify(response.body.token, SECRET)).not.toThrow();
    // The token on the URL says the content may never be written back.
    const backend = new URL(response.body.url).searchParams.get('backend');
    expect(jwt.verify(backend, SECRET).canWrite).toBe(false);
  });

  it('is never cached', async () => {
    await withHistory();

    const response = await as('alice').post('/api/onlyoffice/history', {
      path: 'Projects/notes.txt',
    });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a history the account cannot read', async () => {
    await withHistory();

    expect(
      (await as('nobody').post('/api/onlyoffice/history', { path: 'Projects/notes.txt' })).status
    ).toBe(403);
  });
});

describe('an earlier version opened in the editor', () => {
  it('is a viewer with nothing to save', async () => {
    const save = (content) =>
      request(app).put('/api/editor').send({ path: 'Projects/notes.txt', content });
    await save('first');
    await save('second');
    const versions = load('src/services/versions');
    const [version] = (await versions.listVersions({ user: users.alice }, 'Projects/notes.txt'))
      .versions;

    const response = await as('alice').post('/api/onlyoffice/config', {
      path: 'Projects/notes.txt',
      versionId: version.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.config.editorConfig.mode).toBe('view');
    expect(response.body.config.document.permissions.edit).toBe(false);
    expect(response.body.editorSessionId).toBeNull();
    // Its own key, so it never touches the one the document is open under.
    expect(response.body.config.document.key).toBe(`version-${version.id}`);
    // No callback at all: a version has nothing to write back, and the
    // document's own callback would release the key its editors share.
    expect(response.body.config.editorConfig.callbackUrl).toBeUndefined();
  });

  it('refuses a version of a file the account cannot read', async () => {
    const save = (content) =>
      request(app).put('/api/editor').send({ path: 'Projects/notes.txt', content });
    await save('first');
    await save('second');
    const versions = load('src/services/versions');
    const [version] = (await versions.listVersions({ user: users.alice }, 'Projects/notes.txt'))
      .versions;

    const response = await as('nobody').post('/api/onlyoffice/config', {
      path: 'Projects/notes.txt',
      versionId: version.id,
    });

    expect(response.status).toBe(403);
  });
});
