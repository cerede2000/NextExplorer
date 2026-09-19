import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Who may end an editing session.
 *
 * The route exists to be called from a page that is being closed, which means
 * it is called by a beacon — a request with no reply anybody reads, sent while
 * the tab it came from is disappearing. That is a shape worth looking at
 * twice: a route meant to be easy to reach at an awkward moment must not be
 * easy to reach from somewhere else entirely.
 *
 * Ending somebody's session is not a catastrophe — they lose an editing
 * session, and the document is saved on the way — but it is an interruption
 * anybody could cause, repeatedly, from outside. So the whole stack is wired
 * here, session store and authentication included, rather than the router
 * alone: what is being held is the gate, not the handler.
 *
 * Passwords are hashed with bcrypt at cost 12, hence the timeouts.
 */

const PASSWORD = 'secret123';
const FILE = 'report.docx';

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async () => {
  currentEnv = await setupTestEnv({
    tag: 'onlyoffice-session-end-exposure-',
    env: {
      AUTH_ENABLED: 'true',
      AUTH_MODE: 'local',
      PUBLIC_URL: 'https://files.example.test',
      ONLYOFFICE_URL: 'http://127.0.0.1:1',
      ONLYOFFICE_SECRET: 'onlyoffice-test-secret',
    },
  });

  await fs.writeFile(path.join(currentEnv.volumeDir, FILE), Buffer.from('original'));

  const { configureSession } = currentEnv.requireFresh('src/middleware/session');
  const authMiddleware = currentEnv.requireFresh('src/middleware/authMiddleware');
  const authRoutes = currentEnv.requireFresh('src/routes/auth');
  const userRoutes = currentEnv.requireFresh('src/routes/users');
  const onlyofficeRoutes = currentEnv.requireFresh('src/routes/onlyoffice');
  const { errorHandler, notFoundHandler } = currentEnv.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  configureSession(app);
  app.use(authMiddleware);
  app.use('/api/auth', authRoutes);
  app.use('/api', userRoutes);
  app.use('/api', onlyofficeRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

const setUpOwner = async (app) => {
  const browser = request.agent(app);
  const response = await browser
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD });
  expect(response.status).toBe(201);
  return browser;
};

/** A second account, made by the administrator and signed in for itself. */
const setUpOther = async (app, owner) => {
  const created = await owner.post('/api/users').send({
    email: 'other@example.com',
    username: 'other',
    password: PASSWORD,
    roles: ['user'],
  });
  expect(created.status).toBe(201);

  const other = request.agent(app);
  const signedIn = await other
    .post('/api/auth/login')
    .send({ email: 'other@example.com', password: PASSWORD });
  expect(signedIn.status).toBe(200);
  return other;
};

const openEditor = async (browser) => {
  const config = await browser.post('/api/onlyoffice/config').send({ path: FILE });
  expect(config.status).toBe(200);
  return config.body.forceSaveSessionId;
};

describe('ending an editing session, from outside', () => {
  it('is refused to somebody with no session of their own', { timeout: 30000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);
    const sessionId = await openEditor(owner);

    // A cross-site beacon arrives exactly like this: the session cookie is
    // `SameSite=Lax` and is not attached to a POST another site made, so what
    // reaches the server is a request from nobody. It is refused before the
    // route is reached, which is why the whole stack is wired here.
    const stranger = request(app);
    const refused = await stranger
      .post('/api/onlyoffice/session-end')
      .send({ path: FILE, sessionId });
    expect(refused.status).toBe(401);

    // And the session is untouched: the owner's editor carries on.
    const heartbeat = await owner
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: FILE, sessionId });
    expect(heartbeat.status).toBe(200);
  });

  it('is refused to another account holding the identifier', { timeout: 40000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);
    const other = await setUpOther(app, owner);
    const sessionId = await openEditor(owner);

    // The identifier travels in a request body, so it is not a secret: the
    // question is whether holding it is enough. It is not — a session belongs
    // to whoever opened it.
    const refused = await other.post('/api/onlyoffice/session-end').send({ path: FILE, sessionId });
    expect(refused.status).toBe(403);

    const heartbeat = await owner
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: FILE, sessionId });
    expect(heartbeat.status).toBe(200);
  });

  it('is refused for a file the caller cannot reach', { timeout: 40000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);
    const other = await setUpOther(app, owner);
    await openEditor(owner);

    // The other account's own session, aimed at the owner's personal folder —
    // a path it may not read. The refusal comes from the access check, before
    // anything is ended.
    const refused = await other
      .post('/api/onlyoffice/session-end')
      .send({ path: 'personal/owner/report.docx', sessionId: 'anything' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });

  it('ends it for the account that opened it', { timeout: 30000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);
    const sessionId = await openEditor(owner);

    const ended = await owner.post('/api/onlyoffice/session-end').send({ path: FILE, sessionId });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ ended: true });

    const afterwards = await owner
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: FILE, sessionId });
    expect(afterwards.status).toBe(403);
  });

  it('cannot be reached by an API token either', { timeout: 30000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);
    const sessionId = await openEditor(owner);

    const minted = await owner
      .post('/api/auth/tokens')
      .send({ password: PASSWORD, name: 'Script', scope: 'write' });
    expect(minted.status).toBe(201);

    // The scope lets it write, and the account is the same one — the session
    // check alone would have let this through, because the session does belong
    // to that account. What stops it is the door: a token has no browser, so
    // it has no editing session, so it has no business ending one. Written
    // after this test found it open.
    const refused = await request(app)
      .post('/api/onlyoffice/session-end')
      .set('Authorization', `Bearer ${minted.body.secret}`)
      .send({ path: FILE, sessionId });
    expect(refused.status).toBe(403);

    const heartbeat = await owner
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: FILE, sessionId });
    expect(heartbeat.status).toBe(200);
  });

  it('cannot open an editing session with a token either', { timeout: 30000 }, async () => {
    const app = await build();
    const owner = await setUpOwner(app);

    const minted = await owner
      .post('/api/auth/tokens')
      .send({ password: PASSWORD, name: 'Script', scope: 'write' });
    expect(minted.status).toBe(201);

    // The other half of the same door. A token that could ask for a
    // configuration would be handed an editing session, and the document would
    // be marked as being edited by a script that is not editing it — with
    // nothing to close it but the timeout.
    for (const route of [
      '/api/onlyoffice/config',
      '/api/onlyoffice/session-heartbeat',
      '/api/onlyoffice/force-save',
      '/api/collabora/config',
    ]) {
      const refused = await request(app)
        .post(route)
        .set('Authorization', `Bearer ${minted.body.secret}`)
        .send({ path: FILE, sessionId: 'anything' });
      expect(refused.status, `${route} was open to a token`).toBe(403);
      expect(refused.body.error.code).toBe('AUTH_TOKEN_NOT_ALLOWED');
    }
  });
});
