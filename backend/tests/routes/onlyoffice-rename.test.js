import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Renaming from the editor's title bar is an ordinary rename with one thing
 * that is not ordinary: an editor is still open on the file.
 *
 * The Document Server holds a token minted when the editor opened, naming the
 * path as it was then, and returns it unchanged with every save for as long as
 * the session lasts. If nothing follows the file, the next autosave recreates
 * the old name beside the new one — two documents, neither of them wrong from
 * where it was written.
 */

describe('ONLYOFFICE rename', () => {
  let env;
  let documentServer;
  let app;
  let port;
  let sessionId;
  let callbackPath;
  let callbackToken;
  let documentKey;

  const setup = async (filename = 'report.docx') => {
    documentServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/saved')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end('edited contents');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 0 }));
    });
    await new Promise((resolve, reject) => {
      documentServer.once('error', reject);
      documentServer.listen(0, '127.0.0.1', resolve);
    });
    ({ port } = documentServer.address());

    env = await setupTestEnv({
      tag: 'onlyoffice-rename-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/services/folderSizeHooks',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: `http://127.0.0.1:${port}`,
        ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
      },
    });

    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('original'));

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const config = await request(app).post('/api/onlyoffice/config').send({ path: filename });
    expect(config.status).toBe(200);
    sessionId = config.body.forceSaveSessionId;
    documentKey = config.body.config.document.key;
    const callbackUrl = new URL(config.body.config.editorConfig.callbackUrl);
    callbackPath = `/api/onlyoffice/callback${callbackUrl.search}`;
    callbackToken = config.body.config.token;
  };

  /** What the Document Server sends when it has a saved document waiting. */
  const documentServerSave = () =>
    request(app)
      .post(callbackPath)
      .set('Authorization', `Bearer ${callbackToken}`)
      .send({
        status: 2,
        key: documentKey,
        url: `http://127.0.0.1:${port}/saved.docx`,
      });

  afterEach(async () => {
    if (documentServer) {
      await new Promise((resolve) => documentServer.close(resolve));
      documentServer = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('renames the open document', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: 'report.docx', sessionId, newName: 'quarterly.docx' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: 'quarterly.docx', name: 'quarterly.docx' });
    expect(await fs.readFile(path.join(env.volumeDir, 'quarterly.docx'), 'utf8')).toBe('original');
    await expect(fs.access(path.join(env.volumeDir, 'report.docx'))).rejects.toThrow();
  });

  it('writes a later save to the new name, not the old one', async () => {
    await setup();
    await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: 'report.docx', sessionId, newName: 'quarterly.docx' });

    // The Document Server still holds the token naming report.docx.
    const saved = await documentServerSave();
    expect(saved.status).toBe(200);

    expect(await fs.readFile(path.join(env.volumeDir, 'quarterly.docx'), 'utf8')).toBe(
      'edited contents'
    );
    // The whole point: the old name must not come back.
    await expect(fs.access(path.join(env.volumeDir, 'report.docx'))).rejects.toThrow();
  });

  it('falls back to the token when the session is gone', async () => {
    await setup();

    // No rename, and a token from a session this process never recorded — what
    // a restart mid-edit looks like. The save must still land.
    const orphanToken = jwt.sign(
      {
        typ: 'nextexplorer-backend',
        absolutePath: path.join(env.volumeDir, 'report.docx'),
        logicalPath: 'report.docx',
        space: 'volume',
        canWrite: true,
        sessionId: 'session-that-no-longer-exists',
        userId: 'admin-user',
      },
      'onlyoffice-test-secret',
      { algorithm: 'HS256', expiresIn: 3600 }
    );

    const saved = await request(app)
      .post(`/api/onlyoffice/callback?path=report.docx&backend=${orphanToken}`)
      .set('Authorization', `Bearer ${callbackToken}`)
      .send({ status: 2, key: documentKey, url: `http://127.0.0.1:${port}/saved.docx` });

    expect(saved.status).toBe(200);
    expect(await fs.readFile(path.join(env.volumeDir, 'report.docx'), 'utf8')).toBe(
      'edited contents'
    );
  });

  it('refuses a rename without a valid editing session', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: 'report.docx', sessionId: 'not-a-session', newName: 'stolen.docx' });

    expect(response.status).toBe(403);
    await expect(fs.access(path.join(env.volumeDir, 'stolen.docx'))).rejects.toThrow();
  });

  it('refuses a name that would leave the folder, and one already taken', async () => {
    await setup();
    await fs.writeFile(path.join(env.volumeDir, 'taken.docx'), Buffer.from('someone else'));

    const escaping = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: 'report.docx', sessionId, newName: '../escaped.docx' });
    expect(escaping.status).toBe(400);

    const conflicting = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: 'report.docx', sessionId, newName: 'taken.docx' });
    expect(conflicting.status).toBe(409);
    expect(await fs.readFile(path.join(env.volumeDir, 'taken.docx'), 'utf8')).toBe('someone else');
  });
});
