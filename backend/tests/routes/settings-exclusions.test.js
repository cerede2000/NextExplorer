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

/**
 * Written down is not the same as in effect.
 *
 * Saving the list and telling the worker about it are two separate steps, and
 * a test that reads the setting back sees only the first. Skipping the second
 * leaves the running indexer walking a folder an administrator has just
 * excluded, with the settings page showing it excluded — which is the worst
 * shape a setting can take.
 */
describe('an exclusion an administrator adds while the index is running', () => {
  it('reaches the worker, not only the stored settings', async () => {
    await seed({ SEARCH_INDEX: 'true' });
    try {
      const exclusions = envContext.requireFresh('src/services/searchIndexExclusions');
      expect(exclusions.effectivePaths()).not.toContain('Sauvegardes/2024');

      const response = await request(buildApp(['admin']))
        .patch('/api/settings')
        .send({ searchIndex: { excludedPaths: ['Sauvegardes/2024'] } });
      expect(response.status).toBe(200);

      // The worker decides what it walks from this list, not from the database.
      expect(exclusions.effectivePaths()).toContain('Sauvegardes/2024');
    } finally {
      await envContext.cleanup();
    }
  });

  it('does the same for folder sizes', async () => {
    await seed({ FOLDER_SIZE_MODE: 'full' });
    try {
      const exclusions = envContext.requireFresh('src/services/folderSizeExclusions');

      await request(buildApp(['admin']))
        .patch('/api/settings')
        .send({ folderSize: { excludedPaths: ['Media/raw'] } });

      expect(exclusions.effectivePaths()).toContain('Media/raw');
    } finally {
      await envContext.cleanup();
    }
  });
});
