import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const MODULES = [
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
  documentsOpenInNewTab: true,
  // On by default, so off is the value that has to survive a round trip.
  showVersionMarks: false,
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

  /**
   * A default expiry that is not one used to be stored as no default: minus
   * three weeks sent from the page removed the default the person had, and the
   * page then showed an empty field.
   */
  it.each([
    [{ value: -3, unit: 'weeks' }],
    [{ value: 0, unit: 'days' }],
    [{ value: 3, unit: 'years' }],
    [5],
    ['soon'],
  ])('leaves the default share expiry as it was when sent %j', async (sent) => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultShareExpiration: { value: 3, unit: 'days' } } })
        .expect(200);

      const saved = await request(app)
        .patch('/api/settings')
        .send({ user: { defaultShareExpiration: sent } })
        .expect(200);

      expect(saved.body.user.defaultShareExpiration).toEqual({ value: 3, unit: 'days' });
      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.defaultShareExpiration).toEqual({ value: 3, unit: 'days' });
    } finally {
      await envContext.cleanup();
    }
  });

  it('removes the default share expiry when sent null', async () => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultShareExpiration: { value: 3, unit: 'days' } } })
        .expect(200);

      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultShareExpiration: null } })
        .expect(200);

      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.defaultShareExpiration).toBeNull();
    } finally {
      await envContext.cleanup();
    }
  });

  /**
   * A switch used to be `Boolean(whatever came)`, which has an opinion about
   * everything: `'false'` — what a form field, a query string or a shell
   * client sends — was true, and `0` was false. Either way the preference was
   * set to something nobody had chosen, and answered as though they had.
   *
   * Each case stores the opposite of what the coercion would have made of the
   * value, so "it stayed" cannot be confused with "it was already like that".
   */
  it.each([
    ['showHiddenFiles', 'false', false],
    ['showThumbnails', 0, true],
    ['showSidebarFavorites', 'no', false],
    ['markdownOpensInEditor', '', true],
    ['skipHome', 0, true],
  ])('leaves %s as it was when sent %j', async (key, sent, stored) => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { [key]: stored } })
        .expect(200);

      const saved = await request(app)
        .patch('/api/settings')
        .send({ user: { [key]: sent } })
        .expect(200);

      expect(saved.body.user[key]).toBe(stored);
      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user[key]).toBe(stored);
    } finally {
      await envContext.cleanup();
    }
  });

  /**
   * A view mode we do not have used to become null, and null is a value here:
   * the built-in default. One unknown word therefore put every folder back to
   * the built-in view rather than being refused.
   */
  it('leaves the default view as it was when sent a mode there is no such thing as', async () => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultView: 'list' } })
        .expect(200);

      const saved = await request(app)
        .patch('/api/settings')
        .send({ user: { defaultView: 'mosaic' } })
        .expect(200);

      expect(saved.body.user.defaultView).toBe('list');
      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.defaultView).toBe('list');
    } finally {
      await envContext.cleanup();
    }
  });

  it('still takes null for the default view, which is the built-in one', async () => {
    const { envContext, app } = await buildContext();
    try {
      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultView: 'list' } })
        .expect(200);

      await request(app)
        .patch('/api/settings')
        .send({ user: { defaultView: null } })
        .expect(200);

      const reread = await request(app).get('/api/settings').expect(200);
      expect(reread.body.user.defaultView).toBeNull();
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
