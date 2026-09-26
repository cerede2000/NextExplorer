import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Editing a document with other people, seen from outside it.
 *
 * Two things were missing. A folder gave no sign that anybody had a document
 * open, so it was copied, moved or deleted while an editor was about to write a
 * newer version of it. And closing the editor relied on the callback the
 * Document Server sends when it decides the document is finished with — seconds
 * after the last keystroke, long after the folder behind the editor has been
 * listed again with the old content, and often after the tab was gone.
 */

const SECRET = 'onlyoffice-together-secret';
const DOCUMENT = 'Projects/report.docx';

let env;
let app;
let users;
let documentServer;
let serverUrl;
/** What the Document Server was asked to do, in order. */
let commands;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

beforeEach(async () => {
  commands = [];
  documentServer = http.createServer((req, res) => {
    if (req.url.startsWith('/command')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        commands.push(JSON.parse(body || '{}'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 0 }));
      });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end('edited');
  });
  await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${documentServer.address().port}`;

  env = await setupTestEnv({
    tag: 'onlyoffice-together-',
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
    req.user = users[req.get('x-test-user') || 'alice'];
    next();
  });
  app.use('/api', load('src/routes/browse'));
  app.use('/api', load('src/routes/onlyoffice'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => documentServer.close(resolve));
  await env.cleanup();
});

const openDocument = (who = 'alice') =>
  request(app).post('/api/onlyoffice/config').set('x-test-user', who).send({ path: DOCUMENT });

const heartbeat = (sessionId, who = 'alice') =>
  request(app)
    .post('/api/onlyoffice/session-heartbeat')
    .set('x-test-user', who)
    .send({ path: DOCUMENT, sessionId });

const listing = (who = 'alice') => request(app).get('/api/browse/Projects').set('x-test-user', who);

const rowFor = (body, name) => body.items.find((item) => item.name === name);

const waitForCommand = async () => {
  for (let attempt = 0; attempt < 50 && commands.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return commands;
};

describe('a folder listing', () => {
  it('says nothing about a document nobody has open', async () => {
    const response = await listing();

    expect(rowFor(response.body, 'report.docx').onlyofficeActivity).toBeUndefined();
  });

  it('marks a document somebody has open, and names them', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    const response = await listing();

    const activity = rowFor(response.body, 'report.docx').onlyofficeActivity;
    expect(activity.active).toBe(true);
    expect(activity.users).toContain('Alice');
  });

  it('names everybody in the document', async () => {
    const alice = await openDocument();
    await heartbeat(alice.body.editorSessionId);
    const bob = await openDocument('bob');
    await heartbeat(bob.body.editorSessionId, 'bob');

    const activity = rowFor((await listing()).body, 'report.docx').onlyofficeActivity;

    expect(activity.users.sort()).toEqual(['Alice', 'Bob']);
  });

  it('stops marking it once the last editor has gone', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    await request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId });

    expect(rowFor((await listing()).body, 'report.docx').onlyofficeActivity).toBeUndefined();
  });
});

describe('what an open folder waits on', () => {
  it('answers at once when it is behind what has already happened', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    const response = await request(app).get('/api/onlyoffice/activity-version?since=0');

    expect(response.status).toBe(200);
    expect(response.body.version).toBeGreaterThan(0);
  });

  it('answers when somebody joins a document', async () => {
    const first = await request(app).get('/api/onlyoffice/activity-version');
    const waiting = request(app).get(
      `/api/onlyoffice/activity-version?since=${first.body.version}`
    );

    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    const response = await waiting;
    expect(response.body.version).toBeGreaterThan(first.body.version);
  });

  it('is never cached', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    const response = await request(app).get('/api/onlyoffice/activity-version?since=0');

    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('writing what the editor holds', () => {
  it('asks the Document Server, and says the request was queued', async () => {
    const opened = await openDocument();

    const response = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId, reason: 'auto' });

    expect(response.status).toBe(202);
    expect(response.body.queued).toBe(true);
    const [command] = await waitForCommand();
    expect(command.c).toBe('forcesave');
    expect(command.key).toBe(opened.body.config.document.key);
    expect(command.userdata).toBe(response.body.requestId);
    // Signed, or the Document Server refuses the command outright.
    expect(() => jwt.verify(command.token, SECRET)).not.toThrow();
  });

  /** Two requests for one session must not become two conversions. */
  it('coalesces a close onto a save that is still assembling', async () => {
    const opened = await openDocument();
    const first = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId, reason: 'auto' });

    const second = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId, reason: 'close' });

    expect(second.body.coalesced).toBe(true);
    expect(second.body.requestId).toBe(first.body.requestId);
    expect(second.body.followUp).toBe(true);
  });

  it('is refused without the session that opened the document', async () => {
    await openDocument();

    const response = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: DOCUMENT, sessionId: 'not-a-session' });

    expect(response.status).toBe(403);
  });

  /** The rights are read again here, not taken from the session that was issued. */
  it('is refused once the folder has been put out of reach', async () => {
    const opened = await openDocument();
    await load('src/services/accessControlService').setRules([
      { path: 'Projects', permissions: 'ro', recursive: true },
    ]);

    const response = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId });

    expect(response.status).toBe(403);
    expect(commands).toEqual([]);
  });
});

describe('closing the editor', () => {
  it('flushes what it holds before letting the session go', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);

    const ended = await request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId });

    expect(ended.body).toMatchObject({ ended: true, flushed: true });
    const [command] = await waitForCommand();
    expect(command.c).toBe('forcesave');
  });

  /** Nothing to flush is not a reason to refuse the close. */
  it('ends a reader session without asking for anything', async () => {
    await load('src/services/accessControlService').setRules([
      { path: 'Projects', permissions: 'ro', recursive: true },
    ]);
    const opened = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: DOCUMENT, mode: 'view' });

    // A reader gets no session, so there is nothing to end — and the document
    // was never reported open in the first place.
    expect(opened.body.editorSessionId).toBeNull();
    expect(commands).toEqual([]);
  });

  /**
   * A save the editor made on the way out is a state worth keeping, not one of
   * the automatic ones in between.
   */
  it('keeps the save it asked for as a version of its own', async () => {
    const opened = await openDocument();
    await heartbeat(opened.body.editorSessionId);
    const callbackUrl = new URL(opened.body.config.editorConfig.callbackUrl);
    const backend = callbackUrl.searchParams.get('backend');

    const ended = await request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId });
    await waitForCommand();

    await request(app)
      .post('/api/onlyoffice/callback')
      .query({ path: DOCUMENT, backend })
      .set('Authorization', `Bearer ${jwt.sign({ any: true }, SECRET)}`)
      .send({
        status: 6,
        url: `${serverUrl}/saved.docx`,
        key: opened.body.config.document.key,
        userdata: ended.body.requestId,
      });

    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('edited');
    const db = await load('src/services/db').getDb();
    const store = load('src/services/versions/store');
    const [file] = store.listFiles(db);
    expect(Boolean(file.currentExplicit)).toBe(true);
  });
});
