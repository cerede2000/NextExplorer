import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Saving a preference, through the route the screen uses.
 *
 * Which keys are preferences was decided twice: once in the settings service,
 * which sanitises the value, and once in this route, which decides whether the
 * key is written at all. A preference added to one and not the other produced a
 * toggle that moved on screen, answered success, and stored nothing.
 */

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'settings-preferences-' });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/settings'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const save = (user) => request(app).patch('/api/settings').send({ user });

const stored = async () => load('src/services/settingsService').getUserSettings(alice.id);

describe('a preference the screen offers', () => {
  it.each([
    'showHiddenFiles',
    'showThumbnails',
    'showVersionMarks',
    'documentsOpenInNewTab',
    'showSidebarFavorites',
  ])('is written when %s is saved', async (key) => {
    const response = await save({ [key]: true });

    expect(response.status).toBe(200);
    expect(response.body.user[key]).toBe(true);
    expect((await stored())[key]).toBe(true);
  });

  /**
   * Every key the service knows how to sanitise is a key this route accepts:
   * one list, so neither can gain a preference the other drops.
   */
  it('accepts exactly what the settings service calls a preference', async () => {
    const { USER_SETTING_KEYS } = load('src/services/settingsService');

    for (const key of USER_SETTING_KEYS) {
      const value =
        key === 'defaultShareExpiration' || key === 'skipHome'
          ? null
          : key === 'locale'
            ? 'fr'
            : true;
      const response = await save({ [key]: value });
      expect(response.body.user, `${key} was dropped`).toHaveProperty(key);
    }
  });

  it('ignores a key that is not a preference', async () => {
    const response = await save({ isAdmin: true });

    expect(response.body.user ?? {}).toEqual({});
    expect((await stored()).isAdmin).toBeUndefined();
  });
});
