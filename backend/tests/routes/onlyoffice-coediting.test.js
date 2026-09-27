import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Two people in the same document have to be given the same key.
 *
 * The Document Server files an open document under the key it was handed, and
 * treats a different key as a different document — a second editing session on
 * the same file, invisible to the first, where whoever saves last overwrites the
 * other with nothing to warn either of them.
 *
 * The key used to be computed from the file's mtime and size, so the first save
 * changed it: from that moment, everyone arriving got their own session. That is
 * the failure this pins. The other half matters just as much — once the document
 * is closed the key must change, or the Document Server serves the copy it still
 * has cached instead of the file that was saved.
 */

describe('ONLYOFFICE co-editing', () => {
  let env;
  let app;
  const filename = 'report.docx';

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'onlyoffice-coediting-',
      modules: [
        'src/services/onlyofficeActivityService',
        'src/services/onlyofficeDocumentKeyService',
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: 'http://127.0.0.1:1',
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
  };

  /** Open the document, as a client asking for its editor configuration. */
  const open = async () => {
    const response = await request(app).post('/api/onlyoffice/config').send({ path: filename });
    expect(response.status).toBe(200);
    return {
      key: response.body.config.document.key,
      sessionId: response.body.forceSaveSessionId,
      callbackPath: `/api/onlyoffice/callback${new URL(response.body.config.editorConfig.callbackUrl).search}`,
      token: response.body.config.token,
    };
  };

  /** What the client sends once ONLYOFFICE reports the document ready. */
  const declareOpen = (sessionId) =>
    request(app).post('/api/onlyoffice/session-heartbeat').send({ path: filename, sessionId });

  /** A save landing on disk while the document is open. */
  const documentSaved = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(env.volumeDir, filename), Buffer.from('edited by the first user'));
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('gives the second person the key the first is already using', async () => {
    await setup();

    const first = await open();
    await declareOpen(first.sessionId);
    await documentSaved();

    const second = await open();

    expect(second.key).toBe(first.key);
  });

  it('still hands out a fresh key once the document has been released', async () => {
    await setup();

    const first = await open();
    await declareOpen(first.sessionId);
    await documentSaved();

    // Status 4: Document Server has closed the document without changes left to
    // write. Its cached copy is now the stale one.
    const released = await request(app)
      .post(first.callbackPath)
      .set('Authorization', `Bearer ${first.token}`)
      .send({ status: 4, key: first.key });
    expect(released.body).toEqual({ error: 0 });

    const reopened = await open();

    expect(reopened.key).not.toBe(first.key);
  });

  it('does not reuse a key for a file that changed while nobody had it open', async () => {
    // No one is in the document, so there is no session to protect — and the
    // file is not what the Document Server cached.
    await setup();

    const first = await open();
    await documentSaved();

    const second = await open();

    expect(second.key).not.toBe(first.key);
  });

  it('keeps everyone together when the document is renamed from the editor', async () => {
    await setup();

    const first = await open();
    await declareOpen(first.sessionId);

    const renamed = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: filename, sessionId: first.sessionId, newName: 'quarterly.docx' });
    expect(renamed.status).toBe(200);

    // Someone opening the document under its new name joins the session that is
    // already running, rather than starting a rival one.
    const second = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: 'quarterly.docx' });
    expect(second.status).toBe(200);
    expect(second.body.config.document.key).toBe(first.key);
  });
});
