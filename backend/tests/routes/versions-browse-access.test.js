import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Whether a listing says its files show their history, which is what decides
 * whether the Versions entry appears in the menu: always for a place someone
 * may read, and through a share only when its owner turned it on.
 */

let envContext;
let users;
let app;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'versions-browse-', env: { SHARES_ENABLED: 'true' } });
  users = {
    alice: await load('src/services/users').createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'secret123',
      roles: ['user'],
    }),
  };
  await fs.mkdir(path.join(envContext.volumeDir, 'Projects'), { recursive: true });
  await fs.writeFile(path.join(envContext.volumeDir, 'Projects', 'notes.md'), '# notes\n');

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who?.startsWith('guest:')) {
      req.guestSession = { id: 'guest-session', shareId: who.slice('guest:'.length) };
    } else if (who) {
      req.user = users[who];
    }
    next();
  });
  app.use('/api', load('src/routes/browse'));
  app.use('/api/shares', load('src/routes/shares'));
  app.use('/api/share', load('src/routes/shares'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  await envContext.cleanup();
});

describe('what a listing says about file histories', () => {
  it('shows them in a place someone may read', async () => {
    const response = await request(app).get('/api/browse/Projects').set('x-test-user', 'alice');

    expect(response.status).toBe(200);
    expect(response.body.access.canSeeVersions).toBe(true);
  });

  it('shows them through a share only once its owner turns them on', async () => {
    const folder = await request(app)
      .post('/api/shares')
      .set('x-test-user', 'alice')
      .send({ sourcePath: 'Projects', sharingType: 'anyone' });
    const file = await request(app)
      .post('/api/shares')
      .set('x-test-user', 'alice')
      .send({ sourcePath: 'Projects/notes.md', sharingType: 'anyone' });
    const browseAs = (share) =>
      request(app)
        .get(`/api/share/${share.shareToken}/browse/`)
        .set('x-test-user', `guest:${share.id}`);

    expect((await browseAs(folder.body)).body.access.canSeeVersions).toBe(false);
    expect((await browseAs(file.body)).body.access.canSeeVersions).toBe(false);

    for (const share of [folder.body, file.body]) {
      await request(app)
        .put(`/api/shares/${share.id}`)
        .set('x-test-user', 'alice')
        .send({ versionsVisible: true });
    }

    expect((await browseAs(folder.body)).body.access.canSeeVersions).toBe(true);
    expect((await browseAs(file.body)).body.access.canSeeVersions).toBe(true);
  });
});
