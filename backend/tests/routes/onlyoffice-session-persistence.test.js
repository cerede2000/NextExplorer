import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * An editing session has to outlive the process.
 *
 * The Document Server is handed a token when the editor opens and returns it
 * unchanged with every save, so the token says where the document *was*. The
 * session is what knows where it is now — and while it was held in memory, a
 * restart in the middle of an edit lost that: the next save landed under the old
 * name, recreating a file the user had renamed minutes earlier, with no error
 * anywhere to explain it.
 *
 * The restart is simulated by rebuilding the router from a cleared module cache,
 * which is what a fresh process would do, against the same database.
 */

describe('ONLYOFFICE session persistence', () => {
  let env;
  let app;
  const filename = 'report.docx';

  const buildApp = () => {
    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    return createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });
  };

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'onlyoffice-session-persistence-',
      modules: [
        'src/services/onlyofficeEditorSessionService',
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
    app = buildApp();

    const config = await request(app).post('/api/onlyoffice/config').send({ path: filename });
    expect(config.status).toBe(200);
    return config.body.forceSaveSessionId;
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('still knows the session after a restart', async () => {
    const sessionId = await setup();

    app = buildApp();

    const heartbeat = await request(app)
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: filename, sessionId });

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toEqual({ active: true });
  });

  it('remembers a rename made before the restart', async () => {
    const sessionId = await setup();

    const renamed = await request(app)
      .post('/api/onlyoffice/rename')
      .send({ path: filename, sessionId, newName: 'quarterly.docx' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.path).toBe('quarterly.docx');

    app = buildApp();

    // The session is what a save consults to find the document. Asking under
    // the new name is what the client does after a rename, and it has to be the
    // session that answers — the token still names the old file.
    const heartbeat = await request(app)
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: 'quarterly.docx', sessionId });

    expect(heartbeat.status).toBe(200);
  });

  it('refuses a session that belongs to someone else', async () => {
    // Stored sessions are handed out by id, so ownership has to be checked on
    // every use rather than trusted from whoever holds the identifier.
    const sessionId = await setup();

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    const otherUsersApp = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'someone-else', roles: ['admin'] },
      errorHandler,
    });

    const heartbeat = await request(otherUsersApp)
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: filename, sessionId });

    expect(heartbeat.status).toBe(403);
  });

  it('refuses a session that was closed', async () => {
    const sessionId = await setup();

    await request(app).post('/api/onlyoffice/session-close').send({ path: filename, sessionId });
    app = buildApp();

    const heartbeat = await request(app)
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: filename, sessionId });

    expect(heartbeat.status).toBe(403);
  });
});
