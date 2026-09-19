import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The events a person tries first.
 *
 * The page offers a filter for sixteen kinds of event, and four of them were
 * written by nothing at all: an upload, a restore, a settings change, and an
 * account created or removed. Worse, a deletion was recorded on `DELETE
 * /api/files` and not on `/api/files/delete-stream` — which is the one the
 * interface uses, so deleting a file from the screen wrote nothing.
 *
 * Somebody who switches the log on, uploads a file and deletes it sees an
 * empty page and concludes the feature is broken. These go through the routes
 * the interface actually calls.
 */

let envContext;
let app;
let activityLog;
/** The share a guest arrives through, set by the test that needs one. */
let guestShareId = 'share-1';

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

/** A real account, because a share needs an owner that exists. */
let admin;

const buildApp = () => {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    // A guest is somebody who arrived through a share link: no account, a
    // guest session. The header picks which of the two is asking.
    if (req.get('x-test-guest')) {
      req.guestSession = { id: 'guest-session', shareId: guestShareId };
    } else req.user = admin;
    next();
  });
  application.use('/api', load('src/routes/upload'));
  application.use('/api', load('src/routes/files'));
  application.use('/api', load('src/routes/trash'));
  application.use('/api', load('src/routes/users'));
  application.use('/api', load('src/routes/settings'));
  application.use(load('src/middleware/errorHandler').errorHandler);
  return application;
};

/** Every event of one kind, newest first. */
const eventsOf = async (action) => (await activityLog.readActivity({ action })).events;

beforeEach(async () => {
  envContext = await setupTestEnv({ tag: 'activity-events-', env: { TRASH_ENABLED: 'true' } });
  activityLog = load('src/services/activityLog');
  admin = await load('src/services/users').createLocalUser({
    email: 'admin@example.com',
    username: 'admin',
    displayName: 'Admin',
    password: 'secret123',
    roles: ['admin'],
  });
  const settings = load('src/services/settingsService');
  await settings.setSystemSetting('system', 'activity', { enabled: true, retentionDays: 30 });
  await fs.mkdir(volume('Files'), { recursive: true });
  guestShareId = 'share-1';
  app = buildApp();
});

afterEach(async () => {
  if (envContext) {
    await envContext.cleanup();
    envContext = null;
  }
});

describe('a file arriving', () => {
  it('is recorded as an upload, under the name it landed as', async () => {
    const response = await request(app)
      .post('/api/upload')
      .query({ uploadTo: 'Files', relativePath: 'notes.txt' })
      .attach('filedata', Buffer.from('hello'), 'notes.txt');
    expect(response.status).toBe(200);

    expect(await eventsOf('file.upload')).toMatchObject([
      { actor: 'admin', target: expect.stringContaining('notes.txt') },
    ]);
  });

  it('is told apart from one that came through a share link', async () => {
    // A real share, because a guest session pointing at nothing is refused
    // before anything is recorded — and being refused is not the case here.
    const shares = load('src/services/sharesService');
    const share = await shares.createShare({
      ownerId: admin.id,
      sourceSpace: 'volume',
      sourcePath: 'Files',
      isDirectory: true,
      accessMode: 'readwrite',
      label: 'Drop box',
    });
    guestShareId = share.id;

    // A guest names the path the way a guest sees it: through the link.
    const response = await request(app)
      .post('/api/upload')
      .set('x-test-guest', 'yes')
      .query({ uploadTo: `share/${share.shareToken}`, relativePath: 'from-a-guest.txt' })
      .attach('filedata', Buffer.from('hello'), 'from-a-guest.txt');
    expect(response.status).toBe(200);

    expect(await eventsOf('file.upload')).toEqual([]);
    expect(await eventsOf('share.upload')).toMatchObject([
      { actor: 'guest', userId: null, target: expect.stringContaining('from-a-guest.txt') },
    ]);
  });
});

describe('a file leaving', () => {
  const write = async (name) => {
    await fs.writeFile(volume('Files', name), 'content');
  };

  it('is recorded when the interface deletes it, not only when the API does', async () => {
    await write('doomed.txt');

    const response = await request(app)
      .post('/api/files/delete-stream')
      .send({ items: [{ path: 'Files', name: 'doomed.txt' }] });

    expect(response.status).toBe(200);
    // The file, not the folder it was in: a line naming only the folder says
    // something went missing from somewhere and nothing more.
    expect(await eventsOf('file.delete')).toMatchObject([
      { actor: 'admin', target: 'Files/doomed.txt' },
    ]);
  });

  it('says which of the two it was', async () => {
    await write('gone.txt');

    await request(app)
      .post('/api/files/delete-stream')
      .send({ items: [{ path: 'Files', name: 'gone.txt' }], permanent: true });

    expect(await eventsOf('file.purge')).toHaveLength(1);
    expect(await eventsOf('file.delete')).toEqual([]);
  });

  it('says it went for good when there is no trash for it to go to', async () => {
    // Reported from an installation with the trash switched off: every file
    // deleted was written down as having been moved to a trash that does not
    // exist. The interface asks for nothing in particular when there is no
    // trash to choose between — there is nothing to choose — so the request
    // carried no `permanent`, and the line was written from that rather than
    // from what the deletion did.
    await load('src/services/settingsService').setSystemSetting('system', 'trash', {
      enabled: false,
    });
    await write('no-trash-here.txt');

    await request(app)
      .post('/api/files/delete-stream')
      .send({ items: [{ path: 'Files', name: 'no-trash-here.txt' }] });

    expect(await eventsOf('file.purge')).toMatchObject([
      { actor: 'admin', target: 'Files/no-trash-here.txt' },
    ]);
    expect(await eventsOf('file.delete')).toEqual([]);
  });

  it('writes nothing for an entry that was not there to be deleted', async () => {
    // It used to count every item asked for, whatever became of it, so a
    // deletion of something already gone read as a deletion that happened.
    await request(app)
      .post('/api/files/delete-stream')
      .send({ items: [{ path: 'Files', name: 'never-existed.txt' }] });

    expect(await eventsOf('file.delete')).toEqual([]);
    expect(await eventsOf('file.purge')).toEqual([]);
  });

  it('names a file that actually went, and counts only those', async () => {
    await write('one.txt');
    await write('two.txt');

    await request(app)
      .post('/api/files/delete-stream')
      .send({
        items: [
          { path: 'Files', name: 'never-existed.txt' },
          { path: 'Files', name: 'one.txt' },
          { path: 'Files', name: 'two.txt' },
        ],
      });

    expect(await eventsOf('file.delete')).toMatchObject([
      { target: 'Files/one.txt', detail: JSON.stringify({ items: 2 }) },
    ]);
  });

  it('comes back recorded as a restore', async () => {
    await write('second-thoughts.txt');
    await request(app)
      .post('/api/files/delete-stream')
      .send({ items: [{ path: 'Files', name: 'second-thoughts.txt' }] });

    const trash = await request(app).get('/api/trash');
    const [item] = trash.body.items;
    expect(item).toBeTruthy();

    const restored = await request(app)
      .post('/api/trash/restore')
      .send({ ids: [item.id] });

    expect(restored.status).toBe(200);
    expect(await eventsOf('file.restore')).toMatchObject([
      { actor: 'admin', target: 'second-thoughts.txt' },
    ]);
  });
});

describe('an administrator at work', () => {
  it('records which settings were changed, and not what they were set to', async () => {
    const response = await request(app)
      .patch('/api/settings')
      .send({ trash: { retentionDays: 45 } });
    expect(response.status).toBe(200);

    const [event] = await eventsOf('admin.settings');
    expect(event).toMatchObject({ actor: 'admin' });
    expect(JSON.parse(event.detail)).toEqual({ sections: ['trash'] });
    expect(event.detail).not.toContain('45');
  });

  it('writes nothing when the save carried nothing this server stores', async () => {
    await request(app)
      .patch('/api/settings')
      .send({ trash: { retentionDays: 0 } });

    expect(await eventsOf('admin.settings')).toEqual([]);
  });

  it('records an account created and an account removed, by name', async () => {
    const created = await request(app)
      .post('/api/users')
      .send({
        email: 'someone@example.com',
        username: 'someone',
        password: 'secret123',
        roles: ['user'],
      });
    expect(created.status).toBe(201);

    await request(app).delete(`/api/users/${created.body.user.id}`).send({});

    const events = await eventsOf('admin.user');
    expect(events.map((event) => JSON.parse(event.detail))).toEqual([
      { deleted: true },
      { created: true, roles: ['user'] },
    ]);
    // The account is gone; the lines that name it are not.
    expect(events.every((event) => event.target === 'someone')).toBe(true);
  });
});
