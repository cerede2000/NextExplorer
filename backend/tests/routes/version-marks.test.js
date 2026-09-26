import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The mark in a listing that says a file has earlier versions.
 *
 * Counted once for the whole folder rather than once per row: a folder of three
 * hundred files costs the same query as a folder of three. What it answers is
 * what the file browser needs to show a small clock beside a name — which is
 * how anybody finds out there is a history to look at.
 */

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(env.volumeDir, ...segments);

const save = (file, content) => request(app).put('/api/editor').send({ path: file, content });

const listing = (folder) => request(app).get(`/api/browse/${folder}`);

const named = (body, name) => body.items.find((item) => item.name === name);

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'version-marks-' });

  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });
  await fs.mkdir(volume('Notes'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/browse'));
  app.use('/api', load('src/routes/editor'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

describe('a folder listing', () => {
  it('marks the files that have versions, and how many', async () => {
    await save('Notes/journal.md', 'first');
    await save('Notes/journal.md', 'second');
    await save('Notes/journal.md', 'third');
    await save('Notes/once.md', 'only ever saved once');

    const response = await listing('Notes');

    expect(response.status).toBe(200);
    expect(named(response.body, 'journal.md').versions).toMatchObject({ count: 2 });
    expect(named(response.body, 'journal.md').versions.bytes).toBeGreaterThan(0);
    // A file saved once replaced nothing, so it has no history and no mark.
    expect(named(response.body, 'once.md').versions).toBeUndefined();
  });

  it('says whether histories may be seen here at all', async () => {
    const response = await listing('Notes');

    expect(response.body.access.canSeeVersions).toBe(true);
  });

  /** A folder's own files, not its subfolders': the count must not climb. */
  it('counts only the files directly in the folder', async () => {
    await fs.mkdir(volume('Notes/deeper'), { recursive: true });
    await save('Notes/deeper/inside.md', 'first');
    await save('Notes/deeper/inside.md', 'second');

    const response = await listing('Notes');

    expect(named(response.body, 'deeper').versions).toBeUndefined();
    expect(named(response.body, 'deeper')).toBeTruthy();
  });

  it('leaves the marks out for somebody who turned them off', async () => {
    await save('Notes/journal.md', 'first');
    await save('Notes/journal.md', 'second');
    await load('src/services/settingsService').setUserSetting(alice.id, 'showVersionMarks', false);

    const response = await listing('Notes');

    expect(named(response.body, 'journal.md').versions).toBeUndefined();
  });

  /**
   * A listing is not worth failing over a count. The history is still one
   * right-click away, so a folder whose marks cannot be counted still lists.
   */
  it('still lists a folder whose versions cannot be counted', async () => {
    await save('Notes/journal.md', 'first');
    await save('Notes/journal.md', 'second');
    const store = load('src/services/versions/store');
    const original = store.countKeptInFolder;
    store.countKeptInFolder = () => {
      throw new Error('the index is unreadable');
    };

    try {
      const response = await listing('Notes');

      expect(response.status).toBe(200);
      expect(named(response.body, 'journal.md')).toBeTruthy();
      expect(named(response.body, 'journal.md').versions).toBeUndefined();
    } finally {
      store.countKeptInFolder = original;
    }
  });
});
