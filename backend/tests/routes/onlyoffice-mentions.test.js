import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Mentions in comments.
 *
 * ONLYOFFICE asks for everyone who can be mentioned and filters the list in the
 * editor, so this route answers with names and addresses rather than running a
 * search. That makes it a directory listing, and the only interesting question
 * about a directory listing is who is allowed to read it.
 */

describe('ONLYOFFICE mentions', () => {
  let env;
  let app;
  const filename = 'report.docx';

  const setup = async ({ user } = {}) => {
    env = await setupTestEnv({
      tag: 'onlyoffice-mentions-',
      modules: [
        'src/routes/onlyoffice',
        'src/services/accessManager',
        'src/services/userSearchService',
        'src/services/db',
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
      user: user === undefined ? { id: 'admin-user', roles: ['admin'] } : user,
      errorHandler,
    });
  };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('answers with the list of people who can be mentioned', async () => {
    await setup();

    const response = await request(app).get('/api/onlyoffice/users');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.users)).toBe(true);
    // The seeded administrator is enough to show the shape reaches the editor:
    // it reads id and name, and matches on email when notifying.
    for (const user of response.body.users) {
      expect(user).toHaveProperty('id');
      expect(user).toHaveProperty('name');
      expect(user).toHaveProperty('email');
    }
  });

  it('keeps the user directory away from guests', async () => {
    // A guest editing through a share link has no reason to receive every
    // account name and address on the server.
    await setup({ user: null });

    const response = await request(app).get('/api/onlyoffice/users');

    expect(response.status).toBe(403);
  });

  it('records a mention and says plainly that nothing was delivered', async () => {
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/notify')
      .send({ path: filename, emails: ['someone@example.com'], comment: 'have a look' });

    // Answering `{delivered: false}` rather than an error: the comment itself
    // was saved by the editor, only the notification has nowhere to go.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: false });
  });

  it('refuses a mention that names no document', async () => {
    // The path is what the access check runs on, so a request without one has
    // to be turned away rather than recorded against nothing.
    await setup();

    const response = await request(app)
      .post('/api/onlyoffice/notify')
      .send({ emails: ['someone@example.com'] });

    expect(response.status).toBe(400);
  });

  it('keeps the notify route away from guests', async () => {
    await setup({ user: null });

    const response = await request(app)
      .post('/api/onlyoffice/notify')
      .send({ path: filename, emails: [] });

    expect(response.status).toBe(403);
  });
});
