import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Every route file used to carry its own copy of the admin check, which is how
 * /permissions/chmod and /permissions/chown ended up with none at all. They now
 * share one middleware — these pin that the routes actually refuse a regular
 * user, so a future refactor cannot quietly drop the guard again.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const REGULAR_USER = { id: 'user-1', username: 'regular', roles: ['user'] };
const ADMIN_USER = { id: 'admin-1', username: 'admin', roles: ['admin'] };

const buildApp = (env, routes, user) => {
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

describe('Admin-only routes', () => {
  it('refuses a regular user on settings and user volumes', async () => {
    const env = await setupTestEnv({
      tag: 'admin-guards-',
      env: { USER_VOLUMES: 'true' },
      modules: [
        'src/config/env',
        'src/config/index',
        'src/utils/pathUtils',
        'src/services/db',
        'src/services/users',
        'src/services/userVolumesService',
        'src/services/settingsService',
        'src/middleware/ensureAdmin',
        'src/middleware/errorHandler',
        'src/routes/settings',
        'src/routes/userVolumes',
      ],
    });
    currentEnv = env;

    const settingsRoutes = env.requireFresh('src/routes/settings');
    const volumeRoutes = env.requireFresh('src/routes/userVolumes');

    const logoUpload = await request(buildApp(env, settingsRoutes, REGULAR_USER)).post(
      '/api/settings/upload-logo'
    );
    expect(logoUpload.status).toBe(403);

    const listVolumes = await request(buildApp(env, volumeRoutes, REGULAR_USER)).get(
      '/api/users/user-2/volumes'
    );
    expect(listVolumes.status).toBe(403);

    const browse = await request(buildApp(env, volumeRoutes, REGULAR_USER)).get(
      '/api/admin/browse-directories'
    );
    expect(browse.status).toBe(403);

    // And the refusal is shaped like every other API error, not a bare string.
    expect(listVolumes.body?.error?.message).toMatch(/admin/i);
  });

  it('lets an admin through the same guard', async () => {
    const env = await setupTestEnv({
      tag: 'admin-guards-allow-',
      env: { USER_VOLUMES: 'true' },
      modules: [
        'src/config/env',
        'src/config/index',
        'src/utils/pathUtils',
        'src/services/db',
        'src/services/users',
        'src/services/userVolumesService',
        'src/middleware/ensureAdmin',
        'src/middleware/errorHandler',
        'src/routes/userVolumes',
      ],
    });
    currentEnv = env;

    const volumeRoutes = env.requireFresh('src/routes/userVolumes');
    const response = await request(buildApp(env, volumeRoutes, ADMIN_USER)).get(
      '/api/admin/browse-directories'
    );

    expect(response.status).toBe(200);
  });
});
