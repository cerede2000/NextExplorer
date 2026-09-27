import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The listing must not promise a thumbnail the server will never make.
 *
 * `supportsThumbnail` on a row is what makes the screen ask for one. Whether
 * thumbnails happen at all is settled in two places — THUMBNAILS_ENABLED, for
 * the whole installation, and a setting an administrator can turn off — and the
 * thumbnail route and the share listing have always read both. The folder
 * listing read only the setting, so an installation started with the switch off
 * answered rows claiming thumbnails, and every one of those requests came back
 * refused.
 */

let envContext;

const browseWith = async (env) => {
  envContext = await setupTestEnv({
    tag: 'browse-thumbnails-',
    env,
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/browse',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
    ],
  });

  await fs.mkdir(path.join(envContext.volumeDir, 'Photos'), { recursive: true });
  await fs.writeFile(path.join(envContext.volumeDir, 'Photos', 'plage.jpg'), 'x');

  const browseRoutes = envContext.requireFresh('src/routes/browse');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', ?, ?)`
  ).run(now, now);

  const app = createTestApp({
    router: browseRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });

  const response = await request(app).get('/api/browse/Photos');
  expect(response.status).toBe(200);
  return response.body.items.find((item) => item.name === 'plage.jpg');
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a picture in a folder listing', () => {
  it('is offered a thumbnail when the server makes them', async () => {
    expect(await browseWith({ THUMBNAILS_ENABLED: 'true' })).toMatchObject({
      supportsThumbnail: true,
    });
  });

  it('is offered none when the whole installation has them off', async () => {
    const picture = await browseWith({ THUMBNAILS_ENABLED: 'false' });

    expect(picture).toBeDefined();
    expect(picture.supportsThumbnail).toBeUndefined();
  });
});
