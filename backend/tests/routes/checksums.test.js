import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What a file's bytes add up to, asked for from the panel.
 *
 * Somebody arrives with a checksum written on the page they downloaded a file
 * from, or with two copies of a photo library whose dates and sizes agree. Both
 * questions need the bytes read, which on a large file is the slowest thing
 * this application does to a file it is not moving — so it is asked for rather
 * than offered, it is a registered operation, and the answer is remembered.
 */

let env;

const ALICE = { id: 'alice', roles: ['user'] };
const BOB = { id: 'bob', roles: ['user'] };

const digestOf = (algorithm, text) => crypto.createHash(algorithm).update(text).digest('hex');

const appFor = (user) => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    req.user = user;
    next();
  });
  application.use('/api', env.requireFresh('src/routes/files'));
  application.use('/api', env.requireFresh('src/routes/tasks'));
  application.use(env.requireFresh('src/middleware/errorHandler').errorHandler);
  return application;
};

/** The stream's events, as a client reads them. */
const eventsOf = (response) =>
  response.text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const doneOf = (response) => eventsOf(response).find((event) => event.type === 'done');

const take = (who, body) => request(appFor(who)).post('/api/files/checksums').send(body);
const known = (who, relativePath) =>
  request(appFor(who)).get('/api/files/checksums').query({ path: relativePath });

/**
 * Alice's own volume, so that every case here is asked of a file somebody owns
 * and Bob is somebody who does not.
 */
let hers;
const inHers = (...parts) => path.join(hers, ...parts);

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'checksums-route-', env: { USER_VOLUMES: 'true' } });
  const db = await env.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const [id, username] of [
    ['alice', 'alice'],
    ['bob', 'bob'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
    ).run(id, `${username}@example.com`, username, username, now, now);
  }

  hers = path.join(env.tmpRoot, 'alice-volume');
  await fs.mkdir(path.join(hers, 'Docs'), { recursive: true });
  await fs.writeFile(inHers('Docs', 'report.txt'), 'quarterly figures');
  await env.requireFresh('src/services/userVolumesService').addVolumeToUser({
    userId: 'alice',
    label: 'Mine',
    volumePath: hers,
    accessMode: 'readwrite',
  });
});

afterEach(async () => {
  if (env) {
    env.requireFresh('src/services/operationTasks').reset();
    await env.cleanup();
    env = null;
  }
});

describe('the checksums of a file', () => {
  it('are every digest of its bytes, as a registered operation', async () => {
    const response = await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });

    expect(response.status).toBe(200);
    const stream = eventsOf(response);
    // A window onto an operation, like every other long one: it can be followed
    // from another tab and stopped by asking.
    expect(stream[0]).toMatchObject({
      type: 'start',
      kind: 'checksum',
      taskId: expect.any(String),
    });
    expect(doneOf(response)).toMatchObject({
      success: true,
      items: [
        {
          path: 'Mine/Docs/report.txt',
          name: 'report.txt',
          size: 'quarterly figures'.length,
          digests: {
            md5: digestOf('md5', 'quarterly figures'),
            sha1: digestOf('sha1', 'quarterly figures'),
            sha256: digestOf('sha256', 'quarterly figures'),
          },
        },
      ],
    });
  });

  /**
   * What the operation is called, which is what a panel draws and what the news
   * says afterwards. One file lends it its name; several have none to lend, and
   * a count passed off as a name is drawn as one — "Reading 2…" where 2 is a
   * file nobody has.
   */
  it('is named for the one file it reads, and for no file when it reads several', async () => {
    const one = await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });
    expect(eventsOf(one)[0]).toMatchObject({ name: 'report.txt', totalItems: 1 });

    await fs.writeFile(inHers('Docs', 'second.txt'), 'another file');
    const two = await take(ALICE, {
      items: [
        { path: 'Mine/Docs', name: 'report.txt' },
        { path: 'Mine/Docs', name: 'second.txt' },
      ],
    });

    expect(eventsOf(two)[0]).toMatchObject({ totalItems: 2 });
    expect(eventsOf(two)[0].name).toBeUndefined();
  });

  it('are nothing until somebody asks for them', async () => {
    const before = await known(ALICE, 'Mine/Docs/report.txt');

    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      path: 'Mine/Docs/report.txt',
      digests: null,
      algorithms: ['md5', 'sha1', 'sha256'],
    });
  });

  it('are there to be read back once they have been taken', async () => {
    await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });

    const after = await known(ALICE, 'Mine/Docs/report.txt');

    expect(after.body.digests.sha256).toBe(digestOf('sha256', 'quarterly figures'));
    expect(after.body.computedAt).toBeTypeOf('string');
  });

  /**
   * And are gone the moment the file is not that file any more. Nothing here
   * cleans them: the file's own state is the key, so a row that does not
   * describe what is on disk is not an answer.
   */
  it('are gone once the file has changed, whoever changed it', async () => {
    await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });

    // Changed behind the application's back, as a shell or a share would.
    await fs.writeFile(inHers('Docs', 'report.txt'), 'quarterly figures, revised');
    const later = new Date(Date.now() + 2000);
    await fs.utimes(inHers('Docs', 'report.txt'), later, later);

    expect((await known(ALICE, 'Mine/Docs/report.txt')).body.digests).toBeNull();

    const again = await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });
    expect(doneOf(again).items[0].digests.sha256).toBe(
      digestOf('sha256', 'quarterly figures, revised')
    );
  });

  it('are refused for a folder, which has none', async () => {
    const response = await take(ALICE, { items: [{ path: 'Mine', name: 'Docs' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/only files/i);
  });

  /**
   * The same check a preview or a download runs, and no other: reading the
   * bytes is what somebody who may read the file may do. A volume assigned to
   * one account is the plainest case of a file another may not reach.
   */
  it('are refused for a file the caller cannot read', async () => {
    const root = path.join(env.tmpRoot, 'alice-only');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'private.txt'), 'hers alone');
    await env.requireFresh('src/services/userVolumesService').addVolumeToUser({
      userId: 'alice',
      label: 'Hers',
      volumePath: root,
      accessMode: 'readwrite',
    });

    expect((await take(ALICE, { items: [{ path: 'Hers', name: 'private.txt' }] })).status).toBe(
      200
    );
    expect((await take(BOB, { items: [{ path: 'Hers', name: 'private.txt' }] })).status).toBe(403);
    expect((await known(BOB, 'Hers/private.txt')).status).toBe(403);
  });

  it('are refused for nothing at all', async () => {
    expect((await take(ALICE, { items: [] })).status).toBe(400);
  });
});

describe('comparing files', () => {
  beforeEach(async () => {
    await fs.writeFile(inHers('Docs', 'copy.txt'), 'quarterly figures');
    await fs.writeFile(inHers('Docs', 'other.txt'), 'quarterly figurez');
    await fs.writeFile(inHers('Docs', 'longer.txt'), 'quarterly figures and more');
  });

  const compare = (names) =>
    take(ALICE, {
      compare: true,
      items: names.map((name) => ({ path: 'Mine/Docs', name })),
    });

  it('says they are the same when every byte agrees', async () => {
    const done = doneOf(await compare(['report.txt', 'copy.txt']));

    expect(done.identical).toBe(true);
    expect(done.items.map((item) => item.digests.sha256)).toEqual([
      digestOf('sha256', 'quarterly figures'),
      digestOf('sha256', 'quarterly figures'),
    ]);
  });

  it('says they are not when one byte does not', async () => {
    const done = doneOf(await compare(['report.txt', 'other.txt']));

    expect(done.identical).toBe(false);
    expect(done.because).toBeUndefined();
  });

  /**
   * And answers without reading a thing when the sizes already decide it.
   * Reading eighty gigabytes to prove what two numbers prove is not an answer,
   * it is a waste of somebody's evening.
   */
  it('answers from the sizes alone when they differ, reading nothing', async () => {
    const done = doneOf(await compare(['report.txt', 'longer.txt']));

    expect(done.identical).toBe(false);
    expect(done.because).toBe('size');
    expect(done.items.every((item) => item.digests === null)).toBe(true);
    // Nothing was read, so nothing was remembered either.
    expect((await known(ALICE, 'Mine/Docs/report.txt')).body.digests).toBeNull();
  });

  it('compares three as readily as two', async () => {
    await fs.writeFile(inHers('Docs', 'third.txt'), 'quarterly figures');

    const done = doneOf(await compare(['report.txt', 'copy.txt', 'third.txt']));

    expect(done.identical).toBe(true);
    expect(done.items).toHaveLength(3);
  });
});

/**
 * What the digests do when the file moves, and when it goes.
 *
 * A rename or a move changes the name and not the bytes, so throwing the answer
 * away would mean reading forty gigabytes again to learn what is already known.
 * A deletion is the other way: nothing will ever ask again, and the row should
 * not outlive the file by years.
 *
 * Neither is what keeps a stale answer from being given — that is the key, and
 * it holds even for a write this application never saw. These are so the
 * remembering is worth having and the table stays the size of what exists.
 */
describe('the digests of a file that moves or goes', () => {
  const sha = digestOf('sha256', 'quarterly figures');

  it('follow it when it is renamed', async () => {
    await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });

    const renamed = await request(appFor(ALICE))
      .post('/api/files/rename')
      .send({ path: 'Mine/Docs', name: 'report.txt', newName: 'final.txt' });
    expect(renamed.status).toBe(200);

    const after = await known(ALICE, 'Mine/Docs/final.txt');
    expect(after.body.digests.sha256).toBe(sha);
  });

  it('follow it when it is moved, and the folder it was in with it', async () => {
    await fs.mkdir(inHers('Archive'), { recursive: true });
    await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });

    const moved = await request(appFor(ALICE))
      .post('/api/files/move')
      .send({ items: [{ path: 'Mine/Docs', name: 'report.txt' }], destination: 'Mine/Archive' });
    expect(moved.status).toBe(200);

    const after = await known(ALICE, 'Mine/Archive/report.txt');
    expect(after.body.digests.sha256).toBe(sha);
    // And nothing is left behind under the name it had.
    expect((await known(ALICE, 'Mine/Docs/report.txt')).status).toBe(404);
  });

  /**
   * Read out of the table, because there is nothing else to see: a row for a
   * file that is gone can never match anything again — the key is the file
   * itself — so no answer anywhere would change. What it would do is sit there
   * for every file anybody ever deleted.
   */
  const rowsRemembered = async () => {
    const db = await env.requireFresh('src/services/indexDb').getIndexDb();
    return db.prepare('SELECT COUNT(*) FROM file_checksums').pluck().get();
  };

  it('go when it is deleted for good, rather than outliving it in the table', async () => {
    await take(ALICE, { items: [{ path: 'Mine/Docs', name: 'report.txt' }] });
    expect(await rowsRemembered()).toBe(1);

    const deleted = await request(appFor(ALICE))
      .delete('/api/files')
      .send({ items: [{ path: 'Mine/Docs', name: 'report.txt' }], permanent: true });
    expect(deleted.status).toBe(200);

    expect(await rowsRemembered()).toBe(0);
    // And a file written again in its place is read again rather than answered
    // from what the old one added up to — which the key holds whatever this does.
    await fs.writeFile(inHers('Docs', 'report.txt'), 'quarterly figurez');
    expect((await known(ALICE, 'Mine/Docs/report.txt')).body.digests).toBeNull();
  });
});
