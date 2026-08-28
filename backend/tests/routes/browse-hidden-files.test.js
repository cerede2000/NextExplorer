import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

const createBrowseContext = async ({ env = { HIDDEN_FILE_PATTERNS: '.,@' } } = {}) => {
  const envContext = await setupTestEnv({
    tag: 'browse-hidden-files-test-',
    env,
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/browse',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
      'src/utils/pathUtils',
    ],
  });

  const browseRoutes = envContext.requireFresh('src/routes/browse');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run('admin', 'admin@example.com', 1, 'admin', 'Admin', '["admin"]', now, now);

  const app = createTestApp({
    router: browseRoutes,
    mountPath: '/api',
    user: { id: 'admin', roles: ['admin'] },
    errorHandler,
  });

  return { envContext, app };
};

describe('Browse hidden file patterns', () => {
  let currentEnv;

  afterEach(async () => {
    if (currentEnv) {
      await currentEnv.cleanup();
      currentEnv = null;
    }
  });

  it('uses the user preference to show configured hidden files', async () => {
    const { envContext, app } = await createBrowseContext();
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(envContext.volumeDir, '.test'), 'hidden');
    await fs.mkdir(path.join(envContext.volumeDir, '@eaDir'));

    const hiddenResponse = await request(app).get('/api/browse/');
    expect(hiddenResponse.status).toBe(200);
    expect(hiddenResponse.body.items.map((item) => item.name)).toEqual(['visible.txt']);

    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setUserSetting('admin', 'showHiddenFiles', true);

    const visibleResponse = await request(app).get('/api/browse/');
    expect(visibleResponse.status).toBe(200);
    expect(visibleResponse.body.items.map((item) => item.name).sort()).toEqual([
      '.test',
      '@eaDir',
      'visible.txt',
    ]);
  });
});

/**
 * A killed upload leaves `holiday.mp4.uploading` in the folder. Hiding it is
 * half of the answer — the other half being the sweep in `uploadRemnants` —
 * and it costs nothing to a user who never sees a file they cannot open.
 */
describe('Browse hidden file patterns, as shipped', () => {
  let currentEnv;

  afterEach(async () => {
    if (currentEnv) {
      await currentEnv.cleanup();
      currentEnv = null;
    }
  });

  it('hides the artifacts of a transfer in progress', async () => {
    const { envContext, app } = await createBrowseContext({ env: {} });
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'holiday.mp4'), 'a film');
    await fs.writeFile(path.join(envContext.volumeDir, 'holiday.mp4.uploading'), 'half a film');
    await fs.writeFile(path.join(envContext.volumeDir, 'brochure.pdf.download'), 'half a pdf');

    const response = await request(app).get('/api/browse/');

    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.name)).toEqual(['holiday.mp4']);
  });

  // Hidden is not gone: someone who asks to see everything still finds it.
  it('shows them to a user who asked for hidden files', async () => {
    const { envContext, app } = await createBrowseContext({ env: {} });
    currentEnv = envContext;

    await fs.writeFile(path.join(envContext.volumeDir, 'holiday.mp4.uploading'), 'half a film');
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setUserSetting('admin', 'showHiddenFiles', true);

    const response = await request(app).get('/api/browse/');

    expect(response.body.items.map((item) => item.name)).toEqual(['holiday.mp4.uploading']);
  });
});
