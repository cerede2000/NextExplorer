import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The mark a listing carries on a file that has earlier versions.
 *
 * Counted once for the folder, not once per row, and so the interesting cases
 * are about which rows the one query answers for: the folder's own files and
 * not a descendant's, the files somebody may see the history of and not the
 * others, and nothing at all when they asked not to be shown it.
 */

let envContext;
let users;
let app;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

const as = (who) => ({
  get: (url) => request(app).get(url).set('x-test-user', who),
  put: (url, body) => request(app).put(url).set('x-test-user', who).send(body),
  post: (url, body) => request(app).post(url).set('x-test-user', who).send(body),
});

/** Save through the text editor: the ordinary way an earlier version appears. */
const edit = async (who, filePath, content) => {
  const response = await as(who).put('/api/editor', { path: filePath, content });
  expect(response.status).toBe(200);
};

const browse = async (who, folder) => {
  const response = await as(who).get(`/api/browse/${folder}`);
  expect(response.status).toBe(200);
  return response.body;
};

const markOn = (body, name) => body.items.find((item) => item.name === name)?.versions;

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'browse-marks-', env: { SHARES_ENABLED: 'true' } });
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
    if (who?.startsWith('guest:')) {
      req.guestSession = { id: 'guest-session', shareId: who.slice('guest:'.length) };
    } else if (who) {
      req.user = users[who];
    }
    next();
  });
  app.use('/api', load('src/routes/editor'));
  app.use('/api', load('src/routes/browse'));
  app.use('/api', load('src/routes/versions'));
  app.use('/api/shares', load('src/routes/shares'));
  app.use('/api/share', load('src/routes/shares'));
  app.use(load('src/middleware/errorHandler').errorHandler);

  await write('Projects/notes.md', 'one\n');
  await write('Projects/untouched.md', 'never edited\n');
  await fs.mkdir(volume('Projects', 'deep'), { recursive: true });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await envContext.cleanup();
});

describe('the mark on a row', () => {
  it('says how many versions the file has, and how much they hold', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');
    await edit('alice', 'Projects/notes.md', 'third content\n');

    const listing = await browse('alice', 'Projects');

    expect(markOn(listing, 'notes.md')).toMatchObject({ count: 2, bytes: 4 + 7 });
    expect(markOn(listing, 'notes.md').newest).toEqual(expect.any(String));
  });

  it('is absent, not zero, on a file that has no history', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');

    const listing = await browse('alice', 'Projects');

    // Absent rather than `{ count: 0 }`: the client deletes a missing key on
    // every refresh, and a zero would be a mark that has to be reasoned about
    // at every place that reads one.
    expect(markOn(listing, 'untouched.md')).toBeUndefined();
  });

  it('goes away when the last version does', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');
    expect(markOn(await browse('alice', 'Projects'), 'notes.md')).toMatchObject({ count: 1 });

    const deleted = await as('alice').post('/api/versions/delete', {
      path: 'Projects/notes.md',
      all: true,
    });
    expect(deleted.status).toBe(200);

    expect(markOn(await browse('alice', 'Projects'), 'notes.md')).toBeUndefined();
  });

  it('belongs to the file in this folder and not to one of the same name below it', async () => {
    // The history of `deep/x.md` is keyed by its own name. Answering for the
    // folder above it would put its count on a different file entirely.
    await write('Projects/deep/x.md', 'one\n');
    await write('Projects/x.md', 'a different file\n');
    await edit('alice', 'Projects/deep/x.md', 'two\n');

    const above = await browse('alice', 'Projects');
    const inside = await browse('alice', 'Projects/deep');

    expect(markOn(above, 'x.md')).toBeUndefined();
    expect(markOn(inside, 'x.md')).toMatchObject({ count: 1 });
  });

  it('belongs to the file in this folder and not to one of the same name above it', async () => {
    // The other way round, which a filter on descendants alone would miss:
    // the query has to be bounded to the folder, or every history in the zone
    // is a candidate for a row here that happens to share a name.
    await write('Projects/deep/notes.md', 'a different file\n');
    await edit('alice', 'Projects/notes.md', 'two\n');

    const inside = await browse('alice', 'Projects/deep');

    expect(markOn(inside, 'notes.md')).toBeUndefined();
    expect(markOn(await browse('alice', 'Projects'), 'notes.md')).toMatchObject({ count: 1 });
  });

  it('is never on a folder, whatever its files hold', async () => {
    await write('Projects/deep/x.md', 'one\n');
    await edit('alice', 'Projects/deep/x.md', 'two\n');

    expect(markOn(await browse('alice', 'Projects'), 'deep')).toBeUndefined();
  });
});

describe('who is shown it', () => {
  it('nobody, once they have turned it off', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');
    await load('src/services/settingsService').setUserSetting(
      users.alice.id,
      'showVersionMarks',
      false
    );

    expect(markOn(await browse('alice', 'Projects'), 'notes.md')).toBeUndefined();
  });

  it('still them, when they have said nothing: it is on by default', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');

    expect(markOn(await browse('alice', 'Projects'), 'notes.md')).toMatchObject({ count: 1 });
  });

  it('through a share, only once its owner turned histories on', async () => {
    await edit('alice', 'Projects/notes.md', 'second\n');
    const share = (
      await as('alice').post('/api/shares', { sourcePath: 'Projects', sharingType: 'anyone' })
    ).body;
    const listing = () =>
      request(app)
        .get(`/api/share/${share.shareToken}/browse/`)
        .set('x-test-user', `guest:${share.id}`);

    expect(markOn((await listing()).body, 'notes.md')).toBeUndefined();

    await as('alice').put(`/api/shares/${share.id}`, { versionsVisible: true });

    expect(markOn((await listing()).body, 'notes.md')).toMatchObject({ count: 1 });
  });
});
