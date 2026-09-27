import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A save made through ONLYOFFICE.
 *
 * The Document Server does not send the document: it sends a URL to fetch it
 * from, and the answer to that is what replaces the file. The file used to be
 * emptied before the fetch began, so a slow network, a restart or a refused
 * download left nothing at all where the work had been — and the state the save
 * replaced was gone either way, since nothing kept it.
 *
 * Both are the same change: the document is fetched into a file of its own and
 * handed to the versions, which keep what it replaces and put it in place only
 * once it is whole. A document nobody could save is therefore still the
 * document, and the history the engine has been keeping since it arrived is
 * finally written by somebody.
 */

const SECRET = 'onlyoffice-save-secret';
const DOCUMENT = 'Projects/report.docx';

let env;
let app;
let alice;
let documentServer;
let serverUrl;
/** The same server under another address, as one behind a proxy reports itself. */
let mirror;
let mirrorUrl;
/** Somewhere else entirely, answering perfectly well: what must not be fetched. */
let stranger;
let strangerUrl;
/** What the fake Document Server hands out, and how badly it fails to. */
let saved;

const load = (relative) => require(modulePath(relative));

const absolute = () => path.join(env.volumeDir, ...DOCUMENT.split('/'));

beforeEach(async () => {
  saved = { content: 'second', refuse: false, dieHalfway: false };

  documentServer = http.createServer((req, res) => {
    if (saved.refuse) {
      res.statusCode = 500;
      res.end('no');
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    if (saved.dieHalfway) {
      // Answered, then gone: the network drops, the Document Server restarts.
      // This is the shape that used to destroy the document, since the file was
      // already empty by the time the stream stopped arriving.
      res.setHeader('Content-Length', String(saved.content.length + 100));
      res.write(saved.content.slice(0, 3));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(saved.content);
  });
  await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${documentServer.address().port}`;

  stranger = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end('stolen');
  });
  await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
  strangerUrl = `http://127.0.0.1:${stranger.address().port}`;

  mirror = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(saved.content);
  });
  await new Promise((resolve) => mirror.listen(0, '127.0.0.1', resolve));
  mirrorUrl = `http://127.0.0.1:${mirror.address().port}`;

  env = await setupTestEnv({
    tag: 'onlyoffice-save-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      ONLYOFFICE_URL: serverUrl,
      ONLYOFFICE_SECRET: SECRET,
      ONLYOFFICE_DOWNLOAD_ORIGINS: mirrorUrl,
    },
  });

  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(path.dirname(absolute()), { recursive: true });
  await fs.writeFile(absolute(), 'first');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/onlyoffice'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => documentServer.close(resolve));
  await new Promise((resolve) => mirror.close(resolve));
  await new Promise((resolve) => stranger.close(resolve));
  await env.cleanup();
});

/** As the Document Server calls back: its own token, and the document to fetch. */
const callback = (body) =>
  request(app)
    .post('/api/onlyoffice/callback')
    .query({ path: DOCUMENT })
    .set('Authorization', `Bearer ${jwt.sign({ any: true }, SECRET)}`)
    .send({ url: `${serverUrl}/saved.docx`, key: 'session-key-1', ...body });

/** The versions kept for the only document these tests touch. */
const versionsKept = async () => {
  const db = await load('src/services/db').getDb();
  const store = load('src/services/versions/store');
  const files = store.listFiles(db);
  if (!files.length) return [];
  return store.listVersionsOfFile(db, files[0].id);
};

/** What the history says about the content the document holds now. */
const currentState = async () => {
  const db = await load('src/services/db').getDb();
  const store = load('src/services/versions/store');
  return store.listFiles(db)[0] || null;
};

const contentOf = async (version) => {
  const operations = load('src/services/versions/operations');
  const located = await operations.locateVersion(version.id);
  return fs.readFile(located.absolutePath, 'utf8');
};

describe('the document the Document Server hands back', () => {
  it('replaces the file, and what it replaced is kept', async () => {
    const response = await callback({ status: 2 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ error: 0 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('second');

    const versions = await versionsKept();
    expect(versions).toHaveLength(1);
    expect(await contentOf(versions[0])).toBe('first');
    // Written before the application ever saw the file, so nobody is named:
    // what the save itself is credited with is on the state it wrote.
    expect(versions[0].source).toBe('external');
  });

  it('leaves the document alone when the server refuses to hand it over', async () => {
    saved.refuse = true;

    const response = await callback({ status: 2 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('first');
    expect(await versionsKept()).toHaveLength(0);
  });

  /**
   * The failure the old order could not survive. The document was emptied
   * before the download began, so a stream that stopped arriving — a dropped
   * network, a Document Server restarting mid-answer — left an empty file where
   * the work had been. Nothing is written until the whole document is here.
   */
  it('leaves the document alone when the download dies halfway', async () => {
    saved.dieHalfway = true;

    const response = await callback({ status: 2 });

    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('first');
    expect(await versionsKept()).toHaveLength(0);
  });

  it('credits the person whose changes it carries', async () => {
    await callback({
      status: 2,
      history: { changes: [{ user: { id: alice.id, name: 'Alice' } }] },
    });

    const state = await currentState();
    expect(state.currentSource).toBe('onlyoffice');
    expect(state.currentAuthorId).toBe(alice.id);
    expect(state.currentAuthorLabel).toBe('Alice');

    // And once a second save replaces it, the state she wrote is kept as hers.
    saved.content = 'third';
    await callback({ status: 2, key: 'session-key-2' });

    const versions = await versionsKept();
    const hers = versions.find((version) => version.authorId === alice.id);
    expect(hers, 'the save Alice made was not kept as hers').toBeTruthy();
    expect(hers.source).toBe('onlyoffice');
    expect(await contentOf(hers)).toBe('second');
  });

  /**
   * A save from a share link has no account behind it. It used to be credited
   * to the guest session's own identifier, which names nobody once the session
   * is over.
   */
  it('credits a save made through a share link to the link', async () => {
    await callback({
      status: 2,
      history: { changes: [{ user: { id: 'guest_abc', name: 'Guest User' } }] },
    });

    const state = await currentState();
    expect(state.currentAuthorId).toBeNull();
    expect(state.currentAuthorLabel).toBe('share-link');
  });

  /** Force save (6) is the same save as far as the file is concerned. */
  it('saves a forced save too', async () => {
    saved.content = 'forced';

    const response = await callback({ status: 6, forcesavetype: 1 });

    expect(response.body).toEqual({ error: 0 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('forced');
    expect(await versionsKept()).toHaveLength(1);
  });

  /**
   * The callback says where the document is, and the server used to fetch
   * whatever it was told to — an address on the machine itself, or one inside
   * the container's network, reached by anybody who can reach the callback.
   */
  it('fetches nothing from a server that is not the Document Server', async () => {
    // Answering, and answering well: a refusal here cannot be the network.
    const response = await callback({ status: 2, url: `${strangerUrl}/saved.docx` });

    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('first');
    expect(await versionsKept()).toHaveLength(0);
  });

  /** A Document Server behind a proxy reports itself under the declared host. */
  it('fetches from an address declared beside the Document Server', async () => {
    const response = await callback({ status: 2, url: `${mirrorUrl}/saved.docx` });

    expect(response.body).toEqual({ error: 0 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('second');
  });

  it('acknowledges a status that saves nothing, and writes nothing', async () => {
    const response = await callback({ status: 1 });

    expect(response.body).toEqual({ error: 0 });
    expect(await fs.readFile(absolute(), 'utf8')).toBe('first');
    expect(await versionsKept()).toHaveLength(0);
  });
});
