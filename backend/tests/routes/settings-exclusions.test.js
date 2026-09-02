import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Written at the layer the browser actually talks to.
 *
 * `SEARCH_INDEX_EXCLUDE` was set, the service that reads settings reported it,
 * a test asserted exactly that — and the page still said "no path configured",
 * because the route does not call that function. It calls one that assembles
 * the admin payload field by field, and the new field was not in the list. A
 * test one layer below the defect cannot see the defect.
 */
let envContext;

const buildApp = (roles) => {
  const settingsRoutes = envContext.requireFresh('src/routes/settings');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles };
    next();
  });
  app.use('/api', settingsRoutes);
  app.use(errorHandler);
  return app;
};

const seed = async (env) => {
  envContext = await setupTestEnv({ tag: 'settings-exclusions-', env });
  const dbService = envContext.requireFresh('src/services/db');
  await dbService.getDb();
};

describe('what GET /api/settings tells an administrator', () => {
  it('carries the search index exclusions the environment set', async () => {
    await seed({ SEARCH_INDEX: 'true', SEARCH_INDEX_EXCLUDE: 'Stacks/docker' });
    try {
      const response = await request(buildApp(['admin'])).get('/api/settings');

      expect(response.status).toBe(200);
      expect(response.body.searchIndex).toBeTruthy();
      expect(response.body.searchIndex.environmentExcludedPaths).toEqual(['Stacks/docker']);
      // Beside the folder-size ones, which have always been there.
      expect(response.body.folderSize).toBeTruthy();
    } finally {
      await envContext.cleanup();
    }
  });

  it('does not carry them to someone who is not an administrator', async () => {
    await seed({ SEARCH_INDEX: 'true', SEARCH_INDEX_EXCLUDE: 'Stacks/docker' });
    try {
      const response = await request(buildApp(['user'])).get('/api/settings');

      expect(response.status).toBe(200);
      expect(response.body.searchIndex).toBeUndefined();
    } finally {
      await envContext.cleanup();
    }
  });

  it('takes a path an administrator adds and gives it back', async () => {
    await seed({ SEARCH_INDEX: 'true' });
    try {
      const app = buildApp(['admin']);
      const saved = await request(app)
        .patch('/api/settings')
        .send({ searchIndex: { excludedPaths: ['Sauvegardes/2024'] } });
      expect(saved.status).toBe(200);

      const response = await request(app).get('/api/settings');
      expect(response.body.searchIndex.excludedPaths).toEqual(['Sauvegardes/2024']);
    } finally {
      await envContext.cleanup();
    }
  });
});
