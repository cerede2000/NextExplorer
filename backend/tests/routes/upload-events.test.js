import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What arrived, for whatever waits on the other side of the folder.
 *
 * A pipeline that ingests what people drop into a mounted volume had no good
 * way to hear about it (nxzai/NextExplorer#503): watching the directory fires
 * on every write and cannot tell a finished file from one still arriving, and
 * it needs access to the host, which the consumer often does not have. So a
 * completed upload leaves a row and a consumer reads forward from the last id
 * it saw.
 *
 * The half worth the most care is who sees what. The activity log is behind
 * `ensureAdmin` because a log is everybody who shares the installation; this
 * feed is open to any caller the application knows, an API token included,
 * and earns that by weighing every row on its own — a reader is handed an
 * event only where they could open the file it names.
 */

let envContext;
let app;
let admin;
let outsider;
/** Which of the two the next request is from, or neither. */
let asUser = 'admin';

const load = (relative) => require(modulePath(relative));
const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const buildApp = () => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    if (asUser === 'admin') req.user = admin;
    else if (asUser === 'outsider') req.user = outsider;
    next();
  });
  application.use('/api', load('src/routes/upload'));
  application.use('/api', load('src/routes/events'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

const sendFile = (folder, name, body = 'hello') =>
  request(app)
    .post('/api/upload')
    .query({ uploadTo: folder, relativePath: name })
    .attach('filedata', Buffer.from(body), name);

const feed = (query = {}) => request(app).get('/api/events/uploads').query(query);

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'upload-events-', env: { USER_VOLUMES: 'true' } });
  const users = load('src/services/users');
  admin = await users.createLocalUser({
    email: 'admin@example.com',
    username: 'admin',
    displayName: 'Admin',
    password: 'secret123',
    roles: ['admin'],
  });
  outsider = await users.createLocalUser({
    email: 'someone@example.com',
    username: 'someone',
    displayName: 'Someone',
    password: 'secret123',
    roles: ['user'],
  });
  await fs.mkdir(volume('Ingest'), { recursive: true });
  await fs.mkdir(volume('Theirs'), { recursive: true });
  // The outsider holds one folder, which is not the one things land in.
  await load('src/services/userVolumesService').addVolumeToUser({
    userId: outsider.id,
    label: 'Theirs',
    volumePath: volume('Theirs'),
  });
  asUser = 'admin';
  app = buildApp();
});

afterEach(async () => {
  if (envContext) {
    await envContext.cleanup();
    envContext = null;
  }
});

describe('a file that finished arriving', () => {
  it('leaves one event, under the path the reader browses', async () => {
    expect((await sendFile('Ingest', 'notes.txt')).status).toBe(200);

    const { body } = await feed();
    expect(body.events).toMatchObject([{ path: 'Ingest/notes.txt', size: 5, via: 'direct' }]);
    expect(body.cursor).toBe(body.events[0].id);
  });

  /**
   * One per file, where the activity log keeps one per request: something
   * waiting on the other side acts on files, and a request carrying three of
   * them is three things to ingest.
   */
  it('leaves one for every file of a request, not one for the request', async () => {
    const response = await request(app)
      .post('/api/upload')
      .query({ uploadTo: 'Ingest' })
      .attach('filedata', Buffer.from('a'), 'a.txt')
      .attach('filedata', Buffer.from('bb'), 'b.txt')
      .attach('filedata', Buffer.from('ccc'), 'c.txt');
    expect(response.status).toBe(200);

    const { body } = await feed();
    expect(body.events.map((event) => event.path)).toEqual([
      'Ingest/a.txt',
      'Ingest/b.txt',
      'Ingest/c.txt',
    ]);
  });

  it('says so for a chunked upload too, and says which it was', async () => {
    await load('src/services/settingsService').setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
    });
    const body = Buffer.from('a chunked hello');
    const metadata = Object.entries({
      filename: 'big.txt',
      uploadTo: 'Ingest',
      relativePath: 'big.txt',
    })
      .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
      .join(',');

    const created = await request(app)
      .post('/api/upload/tus')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', String(body.length))
      .set('Upload-Metadata', metadata);
    expect(created.status).toBe(201);
    const sent = await request(app)
      .patch(new URL(created.headers.location).pathname)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Offset', '0')
      .set('Content-Type', 'application/offset+octet-stream')
      .send(body);
    expect(sent.status).toBe(204);

    expect((await feed()).body.events).toMatchObject([
      { path: 'Ingest/big.txt', size: body.length, via: 'chunked' },
    ]);
  });
});

describe('reading forward', () => {
  it('hands over what came after the last id, and nothing twice', async () => {
    await sendFile('Ingest', 'first.txt');
    const first = (await feed()).body;
    expect(first.events).toHaveLength(1);

    // Nothing new yet.
    expect((await feed({ since: first.cursor })).body.events).toEqual([]);

    await sendFile('Ingest', 'second.txt');
    const second = (await feed({ since: first.cursor })).body;
    expect(second.events.map((event) => event.path)).toEqual(['Ingest/second.txt']);
    expect(second.cursor).toBeGreaterThan(first.cursor);
  });

  it('says when there is more than it handed over', async () => {
    await sendFile('Ingest', 'a.txt');
    await sendFile('Ingest', 'b.txt');

    const page = (await feed({ limit: 1 })).body;
    expect(page.events).toHaveLength(1);
    expect(page.more).toBe(true);
    expect((await feed({ since: page.cursor, limit: 1 })).body.more).toBe(false);
  });
});

describe('who is handed an event', () => {
  /**
   * The rule the whole feed rests on. Opening it to any caller the
   * application knows — a script's token included — is only safe because each
   * row is weighed on its own.
   */
  it('is only somebody who could open the file it names', async () => {
    await sendFile('Ingest', 'private.txt');

    asUser = 'outsider';
    const theirs = (await feed()).body;
    expect(theirs.events).toEqual([]);

    // And the cursor still moved: a reader who may see none of a page must
    // not be left asking for the same page for ever.
    expect(theirs.cursor).toBeGreaterThan(0);
  });

  it('is nobody at all when nobody is asking', async () => {
    await sendFile('Ingest', 'private.txt');

    asUser = 'none';
    expect((await feed()).body.events).toEqual([]);
  });
});
