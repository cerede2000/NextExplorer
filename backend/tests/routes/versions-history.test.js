import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A file's history, from the outside.
 *
 * The engine that keeps what a save replaces has been here since the versions
 * landed, and the office editors feed it. Two things were missing: the text
 * editor wrote straight over the file — so a save left nothing behind, and a
 * stop halfway through left the file truncated — and nothing could read a
 * history back.
 *
 * These drive both through the API: save, save again, read what was kept,
 * restore it, and check that restoring did not throw away what was there.
 */

const DOCUMENT = 'Notes/journal.md';

let env;
let app;
let alice;

const load = (relative) => require(modulePath(relative));

const absolute = () => path.join(env.volumeDir, ...DOCUMENT.split('/'));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'versions-history-' });

  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });

  await fs.mkdir(path.dirname(absolute()), { recursive: true });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = alice;
    next();
  });
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/versions'));
  app.use(load('src/middleware/errorHandler').errorHandler);
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const save = (content) => request(app).put('/api/editor').send({ path: DOCUMENT, content });

const history = () => request(app).get('/api/versions').query({ path: DOCUMENT });

const onDisk = () => fs.readFile(absolute(), 'utf8');

/**
 * A version goes out as a download, with its own content type, which supertest
 * does not buffer: the body is collected by hand or the test compares nothing.
 */
const collectBody = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
};

const contentOf = (id, forPath = DOCUMENT) =>
  request(app)
    .get(`/api/versions/${id}/content`)
    .query({ path: forPath })
    .buffer(true)
    .parse(collectBody);

describe('saving a text file', () => {
  it('keeps what it replaced, and says who saved it', async () => {
    expect((await save('first')).status).toBe(200);
    expect((await save('second')).status).toBe(200);

    expect(await onDisk()).toBe('second');

    const listed = await history();
    expect(listed.status).toBe(200);
    expect(listed.body.versions).toHaveLength(1);
    expect(listed.body.file.source).toBe('editor');
    expect(listed.body.file.author?.label).toBe('Alice');
  });

  /** The first save of a file that was not there creates it and keeps nothing. */
  it('keeps nothing for a file that did not exist', async () => {
    await save('first');

    expect(await onDisk()).toBe('first');
    expect((await history()).body.versions).toEqual([]);
  });

  it('never leaves the file as it was found halfway through', async () => {
    await save('first');
    // The content the engine writes goes to a file of its own; the document is
    // only replaced once it is whole. Saving something unwritable therefore
    // leaves the document alone.
    const refused = await request(app).put('/api/editor').send({ path: DOCUMENT, content: null });

    expect(refused.status).toBe(400);
    expect(await onDisk()).toBe('first');
  });
});

describe('a history read back', () => {
  it('hands over the content a version holds', async () => {
    await save('first');
    await save('second');

    const [version] = (await history()).body.versions;
    const content = await contentOf(version.id);

    expect(content.status).toBe(200);
    expect(content.body).toBe('first');
  });

  it('puts a version back, and keeps what was there before it did', async () => {
    await save('first');
    await save('second');

    const [version] = (await history()).body.versions;
    const restored = await request(app)
      .post(`/api/versions/${version.id}/restore`)
      .send({ path: DOCUMENT });

    expect(restored.status).toBe(200);
    expect(await onDisk()).toBe('first');

    // What the restore replaced is a state of its own now: nothing is lost by
    // going back.
    const after = (await history()).body.versions;
    expect(after).toHaveLength(2);
    const contents = await Promise.all(after.map(async (each) => (await contentOf(each.id)).body));
    expect(contents.sort()).toEqual(['first', 'second']);
  });

  it('answers nothing for a file nobody has saved over', async () => {
    await fs.writeFile(absolute(), 'written outside the application');

    const listed = await history();

    expect(listed.status).toBe(200);
    expect(listed.body.versions).toEqual([]);
    expect(listed.body.enabled).toBe(true);
  });

  it('refuses a version that does not belong to the file it is asked about', async () => {
    await save('first');
    await save('second');
    const [version] = (await history()).body.versions;

    const other = 'Notes/other.md';
    await request(app).put('/api/editor').send({ path: other, content: 'elsewhere' });

    const response = await contentOf(version.id, other);

    expect(response.status).toBe(404);
  });
});
