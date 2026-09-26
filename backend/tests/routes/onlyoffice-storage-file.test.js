import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Handing a stored file to the editor.
 *
 * ONLYOFFICE inserts an image, merges a spreadsheet or compares a document by
 * downloading a URL itself, so a file the user picked has to become a URL the
 * Document Server can fetch — and only that file, only for a while, and never
 * with the right to write anything back.
 */

const SECRET = 'onlyoffice-test-secret';

describe('ONLYOFFICE storage file', () => {
  let env;
  let app;

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'onlyoffice-storage-file-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/middleware/errorHandler',
      ],
      env: {
        PUBLIC_URL: 'https://files.example.com',
        ONLYOFFICE_URL: 'http://127.0.0.1:1',
        ONLYOFFICE_SECRET: SECRET,
      },
    });

    await fs.writeFile(path.join(env.volumeDir, 'logo.png'), Buffer.from('image'));
    await fs.mkdir(path.join(env.volumeDir, 'folder'), { recursive: true });

    const routes = env.requireFresh('src/routes/onlyoffice');
    const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
    app = createTestApp({
      router: routes,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('answers with a signed URL the Document Server can fetch', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/storage-file')
      .send({ path: 'logo.png', c: 'add' });

    expect(response.status).toBe(200);
    expect(response.body.fileType).toBe('png');
    expect(response.body.c).toBe('add');

    const url = new URL(response.body.url);
    expect(url.pathname).toBe('/api/onlyoffice/file');
    expect(url.searchParams.get('path')).toBe('logo.png');
    expect(url.searchParams.get('backend')).toBeTruthy();
  });

  it('signs exactly the object it returns', async () => {
    // The editor passes the object straight to insertImage, token included. A
    // token covering anything else is rejected by the Document Server, and the
    // insert fails with nothing on our side to show why.
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/storage-file')
      .send({ path: 'logo.png', c: 'add' });

    const { token, ...payload } = response.body;
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });

    expect(decoded.c).toBe(payload.c);
    expect(decoded.fileType).toBe(payload.fileType);
    expect(decoded.url).toBe(payload.url);
  });

  it('never lets the file be written back through the token it hands out', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/storage-file')
      .send({ path: 'logo.png' });

    const backend = new URL(response.body.url).searchParams.get('backend');
    const decoded = jwt.verify(backend, SECRET, { algorithms: ['HS256'] });

    // The save callback trusts this flag instead of re-resolving permissions.
    expect(decoded.canWrite).toBe(false);
    expect(decoded.sessionId).toBeNull();
    // Short-lived: the editor downloads it immediately, and a long-lived URL
    // to an arbitrary file is worth more to an attacker than it is to anyone.
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(15 * 60);
  });

  it('refuses a folder', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/storage-file')
      .send({ path: 'folder' });

    expect(response.status).toBe(400);
  });

  it('refuses a request without a path', async () => {
    await setup();

    const response = await request(app).post('/api/onlyoffice/storage-file').send({ c: 'add' });

    expect(response.status).toBe(400);
  });
});
