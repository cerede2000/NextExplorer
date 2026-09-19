import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Ending an editing session in one request.
 *
 * Closing the panel over a folder could afford two calls — ask for a last
 * save, wait until this server has accepted it, then end the session. A
 * browser tab being closed can wait for nothing: whatever is sent at that
 * moment is sent in one breath, and a second request that depended on the
 * first would arrive in whichever order the network felt like, or not at all.
 *
 * So the order lives here, and both ways of closing use this one route. What
 * is pinned below is that one call does both things, and that it still ends
 * the session in every case where there is nothing left to save — because a
 * session that does not end is a document reported as being edited by somebody
 * who left.
 */

describe('ending an ONLYOFFICE editing session', () => {
  let env;
  let app;
  let documentServer = null;
  const folder = 'Docs';
  const filename = 'report.docx';
  const documentPath = `${folder}/${filename}`;

  const buildApp = ({ user } = {}) => {
    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    return createTestApp({
      router: routes,
      mountPath: '/api',
      user: user || { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });
  };

  /**
   * A Document Server that accepts a force-save command and says no more.
   *
   * A save is pending from the moment the command is accepted until the
   * document comes back on the callback — which is the window the coalescing
   * lives in. A refused connection closes that window before it opens, which
   * is why the test below needs something that answers.
   */
  const acceptingDocumentServer = async () => {
    documentServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 0 }));
    });
    await new Promise((resolve) => documentServer.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${documentServer.address().port}`;
  };

  const setup = async (options = {}) => {
    env = await setupTestEnv({
      tag: 'onlyoffice-session-end-',
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: options.documentServerUrl || 'http://127.0.0.1:1',
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
      },
    });

    await fs.mkdir(path.join(env.volumeDir, folder), { recursive: true });
    await fs.writeFile(path.join(env.volumeDir, documentPath), Buffer.from('original'));

    app = buildApp(options);

    const config = await request(app).post('/api/onlyoffice/config').send({ path: documentPath });
    expect(config.status).toBe(200);
    return config.body.forceSaveSessionId;
  };

  const end = (sessionId, body = {}) =>
    request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: documentPath, sessionId, ...body });

  const heartbeat = (sessionId) =>
    request(app).post('/api/onlyoffice/session-heartbeat').send({ path: documentPath, sessionId });

  afterEach(async () => {
    if (documentServer) {
      documentServer.closeAllConnections?.();
      await new Promise((resolve) => documentServer.close(resolve));
      documentServer = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('does both in one request: the last save queued, the session ended', async () => {
    const sessionId = await setup();

    const ended = await end(sessionId);

    expect(ended.status).toBe(200);
    expect(ended.body.ended).toBe(true);
    // Both, from one call. What the order between them buys is only visible
    // from the client — a tab on its way out cannot make two calls, and this
    // is the whole reason the route exists.
    expect(ended.body.flushed).toBe(true);
    expect(ended.body.requestId).toEqual(expect.stringContaining('force-save'));

    // And the session is gone: anything still holding it is refused.
    expect((await heartbeat(sessionId)).status).toBe(403);
  });

  it('coalesces with a save already on its way rather than asking twice', async () => {
    const sessionId = await setup({ documentServerUrl: await acceptingDocumentServer() });

    const first = await request(app)
      .post('/api/onlyoffice/force-save')
      .send({ path: documentPath, sessionId, reason: 'auto' });
    expect(first.status).toBe(202);

    const ended = await end(sessionId);

    expect(ended.status).toBe(200);
    // The same request, not a second one: two saves of the same document
    // racing each other is how the older one wins.
    expect(ended.body.requestId).toBe(first.body.requestId);
  });

  it('still ends the session when write access went away under the editor', async () => {
    const sessionId = await setup({ user: { id: 'writer', roles: ['user'] } });

    // The rules change while the document is open: what was writable a minute
    // ago is not. There is nothing left to save — and the close still has to
    // happen, or the document stays marked as being edited by somebody who
    // closed their browser long ago.
    const accessControl = env.requireFresh('src/services/accessControlService');
    await accessControl.setRules([{ path: `/${folder}`, permissions: 'ro', recursive: true }]);

    const ended = await end(sessionId);

    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ ended: true, flushed: false });
    expect((await heartbeat(sessionId)).status).toBe(403);
  });

  it('refuses a session that is not this document’s, and ends nothing', async () => {
    const sessionId = await setup();
    await fs.writeFile(path.join(env.volumeDir, folder, 'other.docx'), Buffer.from('other'));

    const wrongDocument = await request(app)
      .post('/api/onlyoffice/session-end')
      .send({ path: `${folder}/other.docx`, sessionId });
    expect(wrongDocument.status).toBe(403);

    expect((await end('not-a-session')).status).toBe(403);

    for (const body of [{ sessionId: '' }, { sessionId: 42 }]) {
      const refused = await request(app)
        .post('/api/onlyoffice/session-end')
        .send({ path: documentPath, ...body });
      expect(refused.status).toBe(400);
    }

    // None of that touched the real session, which still answers.
    expect((await heartbeat(sessionId)).status).toBe(200);
  });

  it('is the same close twice: ending it again changes nothing', async () => {
    const sessionId = await setup();

    expect((await end(sessionId)).status).toBe(200);
    // A beacon can arrive twice — a tab closed while its panel was closing.
    expect((await end(sessionId)).status).toBe(403);
  });
});
