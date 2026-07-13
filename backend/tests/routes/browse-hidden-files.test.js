import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, setupTestEnv } from '../helpers/env-test-utils.js';

const createBrowseContext = async () => {
  const envContext = await setupTestEnv({
    tag: 'browse-hidden-files-test-',
    env: {
      HIDDEN_FILE_PATTERNS: '.,@',
    },
    modules: [
      'src/config/env',
      'src/config/index',
      'src/routes/browse',
      'src/middleware/errorHandler',
      'src/services/accessManager',
      'src/services/settingsService',
    ],
  });

  const browseRoutes = envContext.requireFresh('src/routes/browse');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
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
