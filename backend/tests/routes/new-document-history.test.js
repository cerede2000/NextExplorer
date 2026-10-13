import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A document that has just been created has no history.
 *
 * Creating a file is not a revision of it: there is no earlier content to keep,
 * so a version recorded here would be an entry nobody asked for, counted in the
 * mark on the row and in the space the history is allowed. The "create and
 * open" button makes a document and takes its author straight into an editor,
 * which is the moment this could go wrong — and an editor opened and left alone
 * must not write either, so nothing appears until somebody saves.
 *
 * The contrast is in these tests on purpose: an absence is only worth asserting
 * where the thing being absent is known to work, so each one is paired with a
 * save that does record a version. What the absence rules out is the file being
 * written twice on its way into the folder — the history keeps nothing when the
 * content has not changed, so a route that took the name with an empty file and
 * then wrote the template over it would leave an empty version behind, and a
 * route that writes once leaves none.
 */

let envContext;
let users;
let app;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  put: (url, body) => request(app).put(url).set('x-test-user', who).send(body),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
});

/** The drawer's "new document" route: the one the two buttons both call. */
const create = async (format, name) => {
  const response = await as('alice').post('/api/files/office-document', {
    path: 'Projects',
    format,
    name,
  });
  expect(response.status).toBe(201);
  return response.body.item.name;
};

const save = async (filePath, content) => {
  const response = await as('alice').put('/api/editor', { path: filePath, content });
  expect(response.status).toBe(200);
  return response;
};

const historyOf = async (filePath) => {
  const response = await as('alice').get(`/api/versions?path=${encodeURIComponent(filePath)}`);
  expect(response.status).toBe(200);
  return response.body.versions || [];
};

const markOn = async (folder, name) => {
  const response = await as('alice').get(`/api/browse/${folder}`);
  expect(response.status).toBe(200);
  return response.body.items.find((item) => item.name === name)?.versions;
};

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'new-document-history-' });
  users = {
    alice: await load('src/services/users').createLocalUser({
      email: 'alice@example.com',
      username: 'alice',
      displayName: 'Alice',
      password: 'secret123',
      roles: ['user'],
    }),
  };

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who) req.user = users[who];
    next();
  });
  app.use('/api', load('src/routes/files/file'));
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/browse'));
  app.use('/api', load('src/routes/versions'));
  app.use(load('src/middleware/errorHandler').errorHandler);

  await fs.mkdir(volume('Projects'), { recursive: true });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await envContext.cleanup();
});

describe('a document straight out of the drawer', () => {
  it('records no version for any of the types the drawer offers', async () => {
    for (const format of ['txt', 'md', 'csv', 'docx', 'xlsx', 'pptx', 'pdf']) {
      const name = await create(format);
      const file = `Projects/${name}`;

      expect(await historyOf(file)).toEqual([]);
      expect(await markOn('Projects', name)).toBeUndefined();
    }
  });

  it('records one the first time it is saved, and not before', async () => {
    const name = await create('md', 'Notes');
    const file = `Projects/${name}`;

    // The editor opening the document reads it; reading is not saving.
    const read = await as('alice').get(`/api/editor?path=${encodeURIComponent(file)}`);
    expect(read.status).toBe(200);
    expect(await historyOf(file)).toEqual([]);

    await save(file, 'the first thing written in it\n');

    // The empty document it was is what the one version holds — which is the
    // proof that the history was working all along, and that the absence above
    // is an absence and not a mechanism that never ran.
    const history = await historyOf(file);
    expect(history).toHaveLength(1);
    expect(history[0].size).toBe(0);
    expect(await markOn('Projects', name)).toMatchObject({ count: 1 });
  });

  it('keeps the file itself out of the history when nothing is written to it', async () => {
    // Two documents, one saved and one only created: the saved one shows the
    // count the created one must not have.
    const written = await create('txt', 'Written');
    const untouched = await create('txt', 'Untouched');

    await save(`Projects/${written}`, 'something\n');

    expect(await markOn('Projects', written)).toMatchObject({ count: 1 });
    expect(await markOn('Projects', untouched)).toBeUndefined();
    expect(await historyOf(`Projects/${untouched}`)).toEqual([]);
  });
});
