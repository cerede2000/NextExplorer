import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The wiring nobody looks at. A route file that stops being mounted breaks
 * nothing at startup and nothing in the tests that exercise it directly — it
 * simply stops answering, and the first report is a user saying a button does
 * nothing.
 *
 * Asked by making a request rather than by reading the router's internals: a
 * mounted route may answer 200, 401, 403 or 500 depending on what it needs, and
 * only 404 means nothing is listening. Reading the internals instead is how the
 * first version of this test broke on an Express upgrade while the application
 * itself was fine.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const build = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'route-registration-', env });
  const registerRoutes = currentEnv.requireFresh('src/routes/index');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', email: 'a@example.com', roles: ['admin'] };
    next();
  });
  registerRoutes(app);
  return app;
};

const answered = async (app, path) => (await request(app).get(path)).status !== 404;

describe('every route file is reachable', () => {
  it.each([
    ['/api/auth/me', 'sign-in'],
    ['/api/browse/', 'browsing'],
    ['/api/volumes', 'volumes'],
    ['/api/favorites', 'favorites'],
    ['/api/settings', 'settings'],
    ['/api/search?q=x', 'search'],
    ['/api/users', 'accounts'],
    ['/api/metadata/', 'details'],
    ['/api/permissions/', 'permissions'],
    ['/api/thumbnails/', 'thumbnails'],
    ['/api/features', 'features'],
    ['/api/usage/', 'volume usage'],
    ['/api/upload/finalizations', 'uploads'],
  ])('answers on %s, which serves %s', async (path) => {
    const app = await build();

    expect(await answered(app, path)).toBe(true);
  });

  /**
   * Folder sizes answer 404 by design when the feature is off, so this one has
   * to be switched on to tell 'not mounted' from 'mounted and disabled'.
   */
  it('answers on /api/folder-size once the feature is on', async () => {
    const app = await build({ FOLDER_SIZE_MODE: 'full' });

    expect(await answered(app, '/api/folder-size/Docs')).toBe(true);
  });

  it('answers 404 there when the feature is off, without being unmounted', async () => {
    const app = await build();

    const response = await request(app).get('/api/folder-size/Docs');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/disabled/i);
  });
});

describe('the editors mount only when they are configured', () => {
  const ONLYOFFICE_PATH = '/api/onlyoffice/users';
  const COLLABORA_PATH = '/api/collabora/wopi/files/abc';

  it('leaves ONLYOFFICE unmounted when no server is set', async () => {
    const app = await build();

    expect(await answered(app, ONLYOFFICE_PATH)).toBe(false);
  });

  it('mounts ONLYOFFICE once a server is set', async () => {
    const app = await build({ ONLYOFFICE_URL: 'https://office.example.com' });

    expect(await answered(app, ONLYOFFICE_PATH)).toBe(true);
  });

  it('leaves Collabora unmounted without both its URL and its secret', async () => {
    const app = await build({ COLLABORA_URL: 'https://collabora.example.com' });

    expect(await answered(app, COLLABORA_PATH)).toBe(false);
  });

  it('mounts Collabora once both are set', async () => {
    const app = await build({
      COLLABORA_URL: 'https://collabora.example.com',
      COLLABORA_SECRET: 'a-secret',
    });

    expect(await answered(app, COLLABORA_PATH)).toBe(true);
  });
});
