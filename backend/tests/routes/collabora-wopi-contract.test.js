import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a token opens, and what it does not.
 *
 * The WOPI endpoints are the one place the application answers without a
 * session: the authentication middleware lets `/api/collabora/wopi/` through so
 * that Collabora, which is a separate server, can fetch and save the document
 * it was handed. The access token is therefore the whole of the authentication,
 * and everything it decides — which file, whether it may be written, whether it
 * is even a token of this kind — is decided here.
 *
 * CI measured this route at forty-three per cent, with two tests for five
 * endpoints. These cover the contract rather than the happy path: the file
 * identifier a token is bound to, the permission it carries, and the locks that
 * stop two people saving over each other.
 */

let currentEnv;

const buildApp = (routes, { notFoundHandler, errorHandler }) => {
  const app = express();
  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

const setup = async () => {
  currentEnv = await setupTestEnv({
    tag: 'collabora-contract-',
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/collabora',
      'src/services/wopiLockService',
      'src/middleware/errorHandler',
    ],
    env: {
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET: 'test-collabora-secret',
      PUBLIC_URL: 'https://files.example.com',
    },
  });

  const { collabora } = currentEnv.requireFresh('src/config/index');
  const routes = currentEnv.requireFresh('src/routes/collabora');
  const errorMiddleware = currentEnv.requireFresh('src/middleware/errorHandler');

  const absolutePath = path.join(currentEnv.tmpRoot, 'quarterly.docx');
  await fs.writeFile(absolutePath, Buffer.from('original'));

  const tokenFor = (claims = {}) =>
    jwt.sign(
      {
        typ: 'nextexplorer-wopi',
        fileId: 'file-1',
        absolutePath,
        canWrite: true,
        userId: 'user-1',
        userName: 'Alice',
        ...claims,
      },
      collabora.secret,
      // `expiresIn` and an explicit `exp` claim contradict each other, and the
      // library refuses both together — a test that wants an expired token
      // states the moment itself.
      'exp' in claims ? { algorithm: 'HS256' } : { algorithm: 'HS256', expiresIn: 60 }
    );

  return { app: buildApp(routes, errorMiddleware), secret: collabora.secret, absolutePath, tokenFor };
};

const info = (app, token, fileId = 'file-1') =>
  request(app).get(`/api/collabora/wopi/files/${fileId}`).query({ access_token: token });

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

describe('the token that stands in for a session', () => {
  it('opens the file it names', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor())).status).toBe(200);
  });

  /** The whole point of binding a token to a file identifier. */
  it('does not open a different file', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor(), 'file-2')).status).toBe(401);
  });

  it('is refused when signed with another secret', async () => {
    const { app, absolutePath } = await setup();
    const forged = jwt.sign({ fileId: 'file-1', absolutePath }, 'not-the-secret', {
      algorithm: 'HS256',
    });

    expect((await info(app, forged)).status).toBe(401);
  });

  it('is refused when it has expired', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor({ exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(
      401
    );
  });

  /**
   * A token of another kind must not stand in for this one. Nothing else signs
   * with this secret today, which is what makes the older tokens below safe to
   * keep accepting — if that changes, this is the test that should stop being
   * true on its own.
   */
  it('is refused when it declares another kind', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor({ typ: 'something-else' }))).status).toBe(401);
  });

  it('is accepted when it predates the kind claim', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor({ typ: undefined }))).status).toBe(200);
  });

  it('is refused when it names no file on disk', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor({ absolutePath: undefined }))).status).toBe(401);
  });

  it('is accepted from the Authorization header as well as the query', async () => {
    const { app, tokenFor } = await setup();

    const response = await request(app)
      .get('/api/collabora/wopi/files/file-1')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(response.status).toBe(200);
  });
});

describe('what the editor is told about the file', () => {
  it('names it', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor())).body.BaseFileName).toBe('quarterly.docx');
  });

  it('reports its size', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor())).body.Size).toBe('original'.length);
  });

  /** The permission the token was issued with, not one the editor may assume. */
  it('says it may be written when the token says so', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor())).body.UserCanWrite).toBe(true);
  });

  it('says it may not when the token says not', async () => {
    const { app, tokenFor } = await setup();

    expect((await info(app, tokenFor({ canWrite: false }))).body.UserCanWrite).toBe(false);
  });

  /**
   * Collabora reloads a document whose version changed underneath it, so the
   * version has to move when the file does.
   */
  it('changes its version when the file changes', async () => {
    const { app, tokenFor, absolutePath } = await setup();
    const before = (await info(app, tokenFor())).body.Version;

    await fs.writeFile(absolutePath, Buffer.from('something rather longer'));
    const after = (await info(app, tokenFor())).body.Version;

    expect(after).not.toBe(before);
  });

  it('keeps the same version while the file does not change', async () => {
    const { app, tokenFor } = await setup();

    const first = (await info(app, tokenFor())).body.Version;
    const second = (await info(app, tokenFor())).body.Version;

    expect(second).toBe(first);
  });

  it('refuses to open a directory', async () => {
    const { app, tokenFor } = await setup();
    const directory = path.join(currentEnv.tmpRoot, 'a-folder');
    await fs.mkdir(directory, { recursive: true });

    const response = await info(app, tokenFor({ absolutePath: directory }));

    expect(response.status).toBe(400);
  });
});

describe('the locks that stop two people saving over each other', () => {
  const lockRequest = (app, token, override, lockId, extra = {}) => {
    const call = request(app)
      .post('/api/collabora/wopi/files/file-1')
      .query({ access_token: token })
      .set('X-WOPI-Override', override);
    if (lockId) call.set('X-WOPI-Lock', lockId);
    if (extra.oldLock) call.set('X-WOPI-OldLock', extra.oldLock);
    return call;
  };

  it('grants a lock on a file nobody holds', async () => {
    const { app, tokenFor } = await setup();

    expect((await lockRequest(app, tokenFor(), 'LOCK', 'lock-a')).status).toBe(200);
  });

  it('refuses a second lock from somebody else', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    expect((await lockRequest(app, tokenFor(), 'LOCK', 'lock-b')).status).toBe(409);
  });

  it('lets the holder take it again', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    expect((await lockRequest(app, tokenFor(), 'LOCK', 'lock-a')).status).toBe(200);
  });

  it('says who holds it', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    const response = await lockRequest(app, tokenFor(), 'GET_LOCK');

    expect(response.headers['x-wopi-lock']).toBe('lock-a');
  });

  it('releases it to its holder', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    expect((await lockRequest(app, tokenFor(), 'UNLOCK', 'lock-a')).status).toBe(200);
  });

  it('does not release it to anybody else', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    expect((await lockRequest(app, tokenFor(), 'UNLOCK', 'lock-b')).status).toBe(409);
  });

  it('lets its holder refresh it', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    expect((await lockRequest(app, tokenFor(), 'REFRESH_LOCK', 'lock-a')).status).toBe(200);
  });

  it('refuses to refresh one that is not held', async () => {
    const { app, tokenFor } = await setup();

    expect((await lockRequest(app, tokenFor(), 'REFRESH_LOCK', 'lock-a')).status).toBe(409);
  });

  it('exchanges one lock for another for its holder', async () => {
    const { app, tokenFor } = await setup();
    await lockRequest(app, tokenFor(), 'LOCK', 'lock-a');

    const response = await lockRequest(app, tokenFor(), 'UNLOCK_AND_RELOCK', 'lock-b', {
      oldLock: 'lock-a',
    });

    expect(response.status).toBe(200);
  });

  it('refuses an operation it does not know', async () => {
    const { app, tokenFor } = await setup();

    expect((await lockRequest(app, tokenFor(), 'SOMETHING_ELSE', 'lock-a')).status).toBe(400);
  });

  it('refuses one with no operation named at all', async () => {
    const { app, tokenFor } = await setup();

    const response = await request(app)
      .post('/api/collabora/wopi/files/file-1')
      .query({ access_token: tokenFor() });

    expect(response.status).toBe(400);
  });
});
