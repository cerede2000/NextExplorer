import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The two background workers an administrator may switch on from Settings.
 *
 * `SEARCH_INDEX` and `FOLDER_SIZE_MODE` were the environment's alone, so
 * turning either on meant editing a file on the host and restarting, beside
 * pages where everything else was a click (#9). The environment still wins when
 * it spoke — the rule the exclusion lists already follow — and Settings decides
 * when it did not.
 *
 * Held at the routes the browser talks to: the page reads /api/features to know
 * what is running and whether it may move it, and writes through
 * PATCH /api/settings.
 */

let envContext;

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const seed = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'background-switches-', env });
  const dbService = envContext.requireFresh('src/services/db');
  await dbService.getDb();
  // As the server does before starting either worker.
  await envContext.requireFresh('src/services/featureSwitches').load();
};

const buildApp = () => {
  const settingsRoutes = envContext.requireFresh('src/routes/settings');
  const featuresRoutes = envContext.requireFresh('src/routes/features');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', email: 'a@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', settingsRoutes);
  app.use('/api', featuresRoutes);
  app.use(errorHandler);
  return app;
};

const features = async (app) => (await request(app).get('/api/features')).body;
const patch = (app, body) => request(app).patch('/api/settings').send(body);

describe('the search index switch', () => {
  it('is off and movable when the environment said nothing', async () => {
    await seed();
    const app = buildApp();

    const before = await features(app);
    expect(before.search.index).toEqual({ enabled: false, lockedBy: null });

    const response = await patch(app, { searchIndex: { enabled: true } });
    expect(response.status).toBe(200);

    expect((await features(app)).search.index.enabled).toBe(true);
  });

  it('turns off again the same way', async () => {
    await seed();
    const app = buildApp();

    await patch(app, { searchIndex: { enabled: true } });
    await patch(app, { searchIndex: { enabled: false } });

    expect((await features(app)).search.index.enabled).toBe(false);
  });

  it('is locked by SEARCH_INDEX, and says so when asked to move', async () => {
    await seed({ SEARCH_INDEX: 'true' });
    const app = buildApp();

    expect((await features(app)).search.index).toEqual({
      enabled: true,
      lockedBy: 'SEARCH_INDEX',
    });

    const response = await patch(app, { searchIndex: { enabled: false } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('SEARCH_INDEX');
    // And the environment's answer is still the one in force.
    expect((await features(app)).search.index.enabled).toBe(true);
  });

  it('is locked when the environment said no, not only when it said yes', async () => {
    // "false" is a decision too: an installation that turned the index off in
    // its file has not left it to whoever next opens the page.
    await seed({ SEARCH_INDEX: 'false' });
    const app = buildApp();

    expect((await features(app)).search.index.lockedBy).toBe('SEARCH_INDEX');
    expect((await patch(app, { searchIndex: { enabled: true } })).status).toBe(400);
    expect((await features(app)).search.index.enabled).toBe(false);
  });

  it('refuses something that is not a yes or a no', async () => {
    await seed();
    const response = await patch(buildApp(), { searchIndex: { enabled: 'yes' } });
    expect(response.status).toBe(400);
  });

  it('comes back after a restart', async () => {
    await seed();
    await patch(buildApp(), { searchIndex: { enabled: true } });

    // A restart: the switch is read from Settings again before anything starts.
    const switches = envContext.requireFresh('src/services/featureSwitches');
    const after = await switches.load();
    expect(after.searchIndex.enabled).toBe(true);
  });
});

describe('the folder size switch', () => {
  it('moves between off, shallow and full when the environment said nothing', async () => {
    await seed();
    const app = buildApp();

    expect((await features(app)).folderSize).toMatchObject({
      mode: 'off',
      enabled: false,
      lockedBy: null,
    });

    expect((await patch(app, { folderSize: { mode: 'full' } })).status).toBe(200);
    expect((await features(app)).folderSize).toMatchObject({ mode: 'full', enabled: true });

    expect((await patch(app, { folderSize: { mode: 'shallow' } })).status).toBe(200);
    expect((await features(app)).folderSize.mode).toBe('shallow');

    expect((await patch(app, { folderSize: { mode: 'off' } })).status).toBe(200);
    expect((await features(app)).folderSize).toMatchObject({ mode: 'off', enabled: false });
  });

  it('refuses a mode it does not have', async () => {
    await seed();
    const app = buildApp();

    expect((await patch(app, { folderSize: { mode: 'deep' } })).status).toBe(400);
    expect((await features(app)).folderSize.mode).toBe('off');
  });

  it('is locked by FOLDER_SIZE_MODE', async () => {
    await seed({ FOLDER_SIZE_MODE: 'shallow' });
    const app = buildApp();

    expect((await features(app)).folderSize).toMatchObject({
      mode: 'shallow',
      lockedBy: 'FOLDER_SIZE_MODE',
    });
    const response = await patch(app, { folderSize: { mode: 'full' } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('FOLDER_SIZE_MODE');
    expect((await features(app)).folderSize.mode).toBe('shallow');
  });
});

describe('what the switches leave alone', () => {
  it('still takes an exclusion list on its own', async () => {
    // The section existed for its list first; sending only the list must not
    // be read as an attempt to move a switch the environment locked.
    await seed({ SEARCH_INDEX: 'true' });
    const response = await patch(buildApp(), { searchIndex: { excludedPaths: ['Stacks/docker'] } });

    expect(response.status).toBe(200);
    expect(response.body.searchIndex.excludedPaths).toEqual(['Stacks/docker']);
  });

  it('writes nothing when a locked switch is sent beside a valid list', async () => {
    // Refused as a whole, before anything is stored: a request reported as
    // refused must not have changed something on the way.
    await seed({ SEARCH_INDEX: 'true' });
    const app = buildApp();

    const response = await patch(app, {
      searchIndex: { excludedPaths: ['Stacks/docker'], enabled: false },
    });
    expect(response.status).toBe(400);

    const settings = (await request(app).get('/api/settings')).body;
    expect(settings.searchIndex.excludedPaths).toEqual([]);
  });
});
