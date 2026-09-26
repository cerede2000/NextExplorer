import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The identity the Document Server files an open document under, and the record
 * of where that document is.
 *
 * Two people editing the same document only see each other when they were given
 * the same key: a different key is a different document to the Document Server,
 * which opens a second, independent session on the same file. Whoever saves
 * last then overwrites the other, with nothing to warn either of them. The key
 * used to be recomputed from the file's own modification time on every open, so
 * it changed under the people already editing — every save of theirs split the
 * session.
 *
 * It also has to change once everybody has left, because the Document Server
 * caches the prepared document under that key and would otherwise serve the
 * stale copy on the next open.
 *
 * The session is the other half: the Document Server is handed a token when the
 * editor opens and returns it unchanged with every save, so the token says
 * where the document *was*. Renaming from the title bar makes that stale at
 * once, and a save arriving afterwards would recreate the old name beside the
 * new one.
 */

const SECRET = 'onlyoffice-session-secret';
const DOCUMENT = 'Projects/report.docx';

let env;
let app;
let users;
let documentServer;
let serverUrl;
let saved;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

beforeEach(async () => {
  saved = { content: 'edited' };
  documentServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(saved.content);
  });
  await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${documentServer.address().port}`;

  env = await setupTestEnv({
    tag: 'onlyoffice-session-',
    env: {
      PUBLIC_URL: 'https://files.example.com',
      ONLYOFFICE_URL: serverUrl,
      ONLYOFFICE_SECRET: SECRET,
    },
  });

  const usersService = load('src/services/users');
  const make = (name, roles) =>
    usersService.createLocalUser({
      email: `${name}@example.com`,
      username: name,
      displayName: name[0].toUpperCase() + name.slice(1),
      password: 'secret123',
      roles,
    });
  users = { alice: await make('alice', ['user']), bob: await make('bob', ['user']) };

  await fs.mkdir(volume('Projects'), { recursive: true });
  await fs.writeFile(volume('Projects', 'report.docx'), 'first');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user') || 'alice';
    req.user = users[who];
    next();
  });
  app.use('/api', load('src/routes/onlyoffice'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await new Promise((resolve) => documentServer.close(resolve));
  await env.cleanup();
});

const openDocument = (file = DOCUMENT, who = 'alice') =>
  request(app).post('/api/onlyoffice/config').set('x-test-user', who).send({ path: file });

const heartbeat = (file, sessionId, who = 'alice') =>
  request(app)
    .post('/api/onlyoffice/session-heartbeat')
    .set('x-test-user', who)
    .send({ path: file, sessionId });

/** The backend token the config put on the callback URL, as the Document Server returns it. */
const backendTokenOf = (body) => {
  const callbackUrl = new URL(body.config.editorConfig.callbackUrl);
  return callbackUrl.searchParams.get('backend');
};

const callback = (body, { backend, file = DOCUMENT } = {}) => {
  const call = request(app)
    .post('/api/onlyoffice/callback')
    .query({ path: file, ...(backend ? { backend } : {}) })
    .set('Authorization', `Bearer ${jwt.sign({ any: true }, SECRET)}`);
  return call.send({ url: `${serverUrl}/saved.docx`, key: 'session-key', ...body });
};

describe('the key a document is opened under', () => {
  it('is the same for everybody already in the document', async () => {
    const first = await openDocument();
    expect(first.status).toBe(200);
    await heartbeat(DOCUMENT, first.body.editorSessionId);

    const second = await openDocument(DOCUMENT, 'bob');

    expect(second.body.config.document.key).toBe(first.body.config.document.key);
  });

  /**
   * A save changes the file, which is what used to change the key — splitting
   * the very session that made the save. Status 6 is a save with the document
   * still open, which is what an autosave and the editor's own Save send.
   */
  it('survives a save made by the people editing', async () => {
    const first = await openDocument();
    await heartbeat(DOCUMENT, first.body.editorSessionId);
    await callback({ status: 6 }, { backend: backendTokenOf(first.body) });

    const again = await openDocument(DOCUMENT, 'bob');

    expect(again.body.config.document.key).toBe(first.body.config.document.key);
    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('edited');
  });

  /** Nobody is in it, and it is not what it was: the cached copy is the stale one. */
  it('changes when the file changed while nobody had it open', async () => {
    const first = await openDocument();
    await fs.writeFile(volume('Projects', 'report.docx'), 'changed underneath');

    const again = await openDocument();

    expect(again.body.config.document.key).not.toBe(first.body.config.document.key);
  });

  it('is dropped once the Document Server says it has let go', async () => {
    const first = await openDocument();
    await heartbeat(DOCUMENT, first.body.editorSessionId);
    const backend = backendTokenOf(first.body);

    // Status 4: closed with no changes. The Document Server keeps its prepared
    // copy under the key, so the key must not be handed out again.
    await callback({ status: 4 }, { backend });
    await fs.writeFile(volume('Projects', 'report.docx'), 'changed while closed');

    const again = await openDocument();

    expect(again.body.config.document.key).not.toBe(first.body.config.document.key);
  });

  /** Putting a version back is a change the editors' cached copy knows nothing about. */
  it('is dropped when a version is restored over the file', async () => {
    const first = await openDocument();
    const keyBefore = first.body.config.document.key;

    const versions = load('src/services/versions/operations');
    await versions.saveFile(
      volume('Projects', 'report.docx'),
      (temporary) => fs.writeFile(temporary, 'second', { flag: 'wx' }),
      { purpose: 'editor', source: 'editor', explicit: true }
    );
    const service = load('src/services/versions');
    const context = { user: users.alice };
    const [version] = (await service.listVersions(context, DOCUMENT)).versions;
    await service.restoreVersion(context, DOCUMENT, version.id);

    const again = await openDocument();

    expect(again.body.config.document.key).not.toBe(keyBefore);
  });
});

describe('the token the editor is given', () => {
  it('is refused when it is a Document Server token signed with the same secret', async () => {
    const opened = await openDocument();
    // Exactly what the Document Server signs with: the same secret, no type.
    const impostor = jwt.sign({ absolutePath: volume('Projects', 'report.docx') }, SECRET);

    const response = await callback({ status: 2 }, { backend: impostor });

    // The callback falls back to resolving the path itself, so the forged
    // absolute path is never the one written to.
    expect(response.body).toEqual({ error: 0 });
    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('edited');
    expect(opened.body.editorSessionId).toBeTruthy();
  });

  it('expires', async () => {
    const opened = await openDocument();
    const payload = jwt.decode(backendTokenOf(opened.body));

    expect(payload.exp).toBeTruthy();
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60);
  });

  it('says whether the session it was issued for may write', async () => {
    const opened = await openDocument();

    expect(jwt.decode(backendTokenOf(opened.body)).canWrite).toBe(true);
  });

  /**
   * A read-only folder used to hand out an editing session all the same: the
   * decision looked only at the requested mode and at whether the document came
   * through a read-only share, never at the location's own rights.
   */
  it('refuses to write a document in a folder this account may only read', async () => {
    await load('src/services/accessControlService').setRules([
      { path: 'Projects', permissions: 'ro', recursive: true },
    ]);

    const opened = await openDocument();

    expect(opened.body.editorSessionId).toBeNull();
    expect(opened.body.config.document.permissions.edit).toBe(false);
    expect(jwt.decode(backendTokenOf(opened.body)).canWrite).toBe(false);

    const response = await callback({ status: 2 }, { backend: backendTokenOf(opened.body) });

    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('first');
  });

  /** A viewer's token must not be enough to write the document. */
  it('refuses a save made with a read-only session', async () => {
    const opened = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: DOCUMENT, mode: 'view' });

    expect(opened.body.editorSessionId).toBeNull();
    const readOnly = jwt.decode(backendTokenOf(opened.body));
    expect(readOnly.canWrite).toBe(false);

    const response = await callback({ status: 2 }, { backend: backendTokenOf(opened.body) });

    // Per the ONLYOFFICE contract a refusal is reported as error 1, not a status.
    expect(response.body).toEqual({ error: 1 });
    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('first');
  });
});

describe('the editor it is opened with', () => {
  it('refuses a file it has no editor for, rather than guessing', async () => {
    await fs.writeFile(volume('Projects', 'drawing.zzz'), 'not a document');

    const response = await openDocument('Projects/drawing.zzz');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/no editor for \.zzz/i);
  });

  it('opens a drawing as a presentation, which is what the Document Server calls it', async () => {
    await fs.writeFile(volume('Projects', 'plan.odg'), 'drawing');

    const response = await openDocument('Projects/plan.odg');

    expect(response.body.config.documentType).toBe('slide');
  });
});

describe('renaming the document from the title bar', () => {
  const rename = (newName, sessionId, file = DOCUMENT, who = 'alice') =>
    request(app)
      .post('/api/onlyoffice/rename')
      .set('x-test-user', who)
      .send({ path: file, sessionId, newName });

  it('moves the file and keeps the session on it', async () => {
    const opened = await openDocument();

    const renamed = await rename('quarterly.docx', opened.body.editorSessionId);

    expect(renamed.status).toBe(200);
    expect(renamed.body.path).toBe('Projects/quarterly.docx');
    expect(await fs.readFile(volume('Projects', 'quarterly.docx'), 'utf8')).toBe('first');
  });

  /**
   * The save arrives with the token minted before the rename, which still names
   * the old path. Left alone it recreated the old name beside the new one.
   */
  it('lands a later save on the new name, not the old one', async () => {
    const opened = await openDocument();
    const backend = backendTokenOf(opened.body);
    await rename('quarterly.docx', opened.body.editorSessionId);

    await callback({ status: 2 }, { backend });

    expect(await fs.readFile(volume('Projects', 'quarterly.docx'), 'utf8')).toBe('edited');
    await expect(fs.stat(volume('Projects', 'report.docx'))).rejects.toThrow();
  });

  it('keeps the people already editing together', async () => {
    const opened = await openDocument();
    await heartbeat(DOCUMENT, opened.body.editorSessionId);
    await rename('quarterly.docx', opened.body.editorSessionId);

    const joining = await openDocument('Projects/quarterly.docx', 'bob');

    expect(joining.body.config.document.key).toBe(opened.body.config.document.key);
  });

  it('is refused without the session that opened the document', async () => {
    await openDocument();

    expect((await rename('quarterly.docx', 'not-a-session')).status).toBe(403);
    expect(await fs.readFile(volume('Projects', 'report.docx'), 'utf8')).toBe('first');
  });

  it("is refused to somebody else's session", async () => {
    const opened = await openDocument();

    const response = await rename('quarterly.docx', opened.body.editorSessionId, DOCUMENT, 'bob');

    expect(response.status).toBe(403);
  });

  /** A name with a separator in it is the caller's mistake, not a server fault. */
  it('answers a bad name as a bad request', async () => {
    const opened = await openDocument();

    const response = await rename('../escape.docx', opened.body.editorSessionId);

    expect(response.status).toBe(400);
  });
});

describe('the session', () => {
  it('reports the document open once the editor says it is ready', async () => {
    const opened = await openDocument();

    const beat = await heartbeat(DOCUMENT, opened.body.editorSessionId);

    expect(beat.status).toBe(200);
    expect(beat.body.active).toBe(true);
  });

  it('is not open merely because a configuration was asked for', async () => {
    await openDocument();

    const activity = load('src/services/onlyofficeActivityService');

    expect(activity.get(volume('Projects', 'report.docx'))?.active).toBeFalsy();
  });

  it("refuses somebody else's session", async () => {
    const opened = await openDocument();

    const beat = await heartbeat(DOCUMENT, opened.body.editorSessionId, 'bob');

    expect(beat.status).toBe(403);
  });

  it('ends, and the document stops being reported as open', async () => {
    const opened = await openDocument();
    await heartbeat(DOCUMENT, opened.body.editorSessionId);

    const ended = await request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId });

    expect(ended.status).toBe(200);
    const activity = load('src/services/onlyofficeActivityService');
    expect(activity.get(volume('Projects', 'report.docx'))?.active).toBeFalsy();
    // And it is gone: a second end is no longer a session anybody holds.
    expect(
      (
        await request(app)
          .post('/api/onlyoffice/session-end')
          .send({ path: DOCUMENT, sessionId: opened.body.editorSessionId })
      ).status
    ).toBe(403);
  });

  /**
   * Only a terminal callback released a key, so a browser closed on the editor
   * — or a restart — left the row for good, one for every document ever opened.
   */
  it('has its key swept once it has expired', async () => {
    await openDocument();
    const db = await load('src/services/db').getDb();
    db.prepare('UPDATE onlyoffice_document_keys SET expires_at = ?').run(
      new Date(Date.now() - 1000).toISOString()
    );

    const purged = await load(
      'src/services/onlyofficeDocumentKeyService'
    ).purgeExpiredDocumentKeys();

    expect(purged).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM onlyoffice_document_keys').get().n).toBe(0);
  });
});
