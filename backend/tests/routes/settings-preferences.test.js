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
   *
   * A value each preference actually takes, and the value is what is asserted
   * rather than the key being present: the answer carries the settings as they
   * now stand, so a key stored by an earlier turn of this loop would still be
   * there after the one that dropped it.
   */
  const A_VALUE_IT_TAKES = {
    defaultShareExpiration: null,
    skipHome: null,
    locale: 'fr',
    defaultView: 'list',
    downloadMode: 'separate',
  };

  it('accepts exactly what the settings service calls a preference', async () => {
    const { WRITABLE_USER_SETTINGS } = load('src/services/settingsService');

    for (const key of WRITABLE_USER_SETTINGS) {
      // `true` is the value a switch takes. A preference that takes something
      // else has to say so above, and the message says that rather than leaving
      // the next person to work out why their key was "dropped": the sanitiser
      // refused the value this loop invented, not the key.
      const value = key in A_VALUE_IT_TAKES ? A_VALUE_IT_TAKES[key] : true;
      const response = await save({ [key]: value });
      const remedy = `${key} was dropped — add a value it takes to A_VALUE_IT_TAKES`;
      expect(response.body.user?.[key], remedy).toEqual(value);
      expect((await stored())[key], `${key} was not stored`).toEqual(value);
    }
  });

  it('ignores a key that is not a preference', async () => {
    const response = await save({ isAdmin: true });

    expect(response.body.user).not.toHaveProperty('isAdmin');
    expect((await stored()).isAdmin).toBeUndefined();
  });
});
