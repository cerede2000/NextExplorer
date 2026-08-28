import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const MODULES = [
  'src/services/storage/jsonStorage',
  'src/services/settingsService',
  'src/services/db',
  'src/routes/settings',
  'src/middleware/errorHandler',
];

/**
 * The route, not the service underneath it.
 *
 * A preference used to have to be listed in two places — sanitised in the
 * service and allowed in the route — and a key present in one but not the other
 * was accepted by the API, silently dropped, and answered with its previous
 * value. The client applied that answer, so the switch flicked itself back off.
 * Testing setUserSetting directly could not see it: the route was the half that
 * was missing.
 */
const buildContext = async () => {
  const envContext = await setupTestEnv({ tag: 'settings-route-test-', modules: MODULES });
  const settingsService = envContext.requireFresh('src/services/settingsService');
  const settingsRoutes = envContext.requireFresh('src/routes/settings');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('user-1', 'user-1@example.com', 1, 'user-1', 'User 1', '["user"]', now, now);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', email: 'user-1@example.com', roles: ['user'] };
    next();
  });
  app.use('/api', settingsRoutes);
  app.use(errorHandler);

  return { envContext, app, settingsService };
};

// A value that is different from every default, so "it came back" cannot be
// confused with "it was already like that".
const NON_DEFAULT = {
  showHiddenFiles: true,
  showThumbnails: false,
  showSidebarFavorites: false,
  showSidebarShares: false,
  showSidebarTools: false,
  markdownOpensInEditor: true,
  defaultShareExpiration: { value: 3, unit: 'days' },
  skipHome: true,
  defaultView: 'list',
};

describe('PATCH /api/settings — user preferences', () => {
  it('saves the markdown preference and reads it back', async () => {
    const { envContext, app } = await buildContext();
    try {
      const saved = await request(app)
        .patch('/api/settings')
        .send({ user: { markdownOpensInEditor: true } })
        .expect(200);

      // The response is what the client applies to its own state, so the value
      // has to be in it — not merely stored somewhere.
      expect(saved.body.user?.markdownOpensInEditor).toBe(true);

      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.markdownOpensInEditor).toBe(true);
    } finally {
      await envContext.cleanup();
    }
  });

  // Every writable preference, so the next one added is covered without anyone
  // having to remember to write a test for it.
  it('saves and reads back every writable preference', async () => {
    const { envContext, app, settingsService } = await buildContext();
    try {
      const writable = [...settingsService.WRITABLE_USER_SETTINGS];

      // Guard against the list and this test drifting apart.
      for (const key of writable) {
        expect(NON_DEFAULT, `add ${key} to NON_DEFAULT`).toHaveProperty(key);
      }

      const payload = Object.fromEntries(writable.map((key) => [key, NON_DEFAULT[key]]));
      const saved = await request(app).patch('/api/settings').send({ user: payload }).expect(200);

      for (const key of writable) {
        expect(saved.body.user?.[key], `${key} missing from the response`).toEqual(
          NON_DEFAULT[key]
        );
      }

      const reread = await request(app).get('/api/settings').expect(200);
      for (const key of writable) {
        expect(reread.body.user[key], `${key} was not persisted`).toEqual(NON_DEFAULT[key]);
      }
    } finally {
      await envContext.cleanup();
    }
  });

  it('ignores a key that is not a user preference', async () => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { notASetting: 'x' } })
        .expect(200);

      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.notASetting).toBeUndefined();
    } finally {
      await envContext.cleanup();
    }
  });
});
