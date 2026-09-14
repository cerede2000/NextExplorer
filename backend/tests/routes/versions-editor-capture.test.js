import fs from 'node:fs/promises';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the text editor's saves leave in a file's history — from inside the
 * application and through a share link.
 *
 * Both used to write over the file in place: a crash in the middle of a save
 * left it truncated, and nothing of what it held before was kept. They now
 * write beside it and rename, and every save keeps what it replaced.
 */

let env;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'versions-editor-', env: { USER_VOLUMES: 'true' } });
  await fs.mkdir(path.join(env.volumeDir, 'Projects'), { recursive: true });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

const volume = (...segments) => path.join(env.volumeDir, ...segments);

/** The versions kept for a file under `root`, newest first, with what each holds. */
const versionsUnder = async (root, inside) => {
  const db = await load('src/services/db').getDb();
  const zones = load('src/services/trash/zones');
  const trashStore = load('src/services/trash/store');
  const store = load('src/services/versions/store');
  const zone = trashStore.listZones(db).find((candidate) => candidate.root === root);
  const file = zone ? store.findFileAt(db, zone.id, inside) : null;
  if (!file) return [];
  return Promise.all(
    store.listVersionsOfFile(db, file.id).map(async (version) => ({
      ...version,
      content: await fs.readFile(path.join(zones.versionsDirectory(zone.root), version.id), 'utf8'),
    }))
  );
};

describe('the text editor', () => {
  const app = () =>
    createTestApp({
      router: load('src/routes/editor'),
      mountPath: '/api',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice', roles: ['admin'] },
      errorHandler: load('src/middleware/errorHandler').errorHandler,
    });

  it('keeps what every save replaces, credited to whoever wrote it', async () => {
    await fs.writeFile(volume('Projects/notes.md'), '# Draft\n');
    const application = app();

    for (const content of ['# Second\n', '# Third\n']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(application)
        .put('/api/editor')
        .send({ path: 'Projects/notes.md', content });
      expect(response.status).toBe(200);
    }

    expect(await fs.readFile(volume('Projects/notes.md'), 'utf8')).toBe('# Third\n');
    const [newest, oldest] = await versionsUnder(volume('Projects'), 'notes.md');
    expect(newest).toMatchObject({
      content: '# Second\n',
      authorId: 'user-1',
      authorLabel: 'Alice',
      source: 'editor',
    });
    expect(oldest).toMatchObject({ content: '# Draft\n', source: 'external' });
  });

  it('replaces the file in one rename, keeping its permissions and leaving nothing beside it', async () => {
    await fs.writeFile(volume('Projects/run.sh'), 'echo one\n');
    await fs.chmod(volume('Projects/run.sh'), 0o750);
    const before = await fs.stat(volume('Projects/run.sh'));

    await request(app())
      .put('/api/editor')
      .send({ path: 'Projects/run.sh', content: 'echo two\n' });

    const after = await fs.stat(volume('Projects/run.sh'));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o750);
    // Beside the file, only the zone the versions live in, which no listing shows.
    expect(await fs.readdir(volume('Projects'))).toEqual(['.nextexplorer', 'run.sh']);
  });

  it('creates a new file without a history', async () => {
    const response = await request(app())
      .put('/api/editor')
      .send({ path: 'Projects/new.txt', content: 'hello' });

    expect(response.status).toBe(200);
    expect(await fs.readFile(volume('Projects/new.txt'), 'utf8')).toBe('hello');
    expect(await versionsUnder(volume('Projects'), 'new.txt')).toEqual([]);
  });
});

describe('the text editor through a share link', () => {
  const buildApp = ({ user } = {}) => {
    const application = express();
    application.use(express.json());
    application.use(cookieParser());
    application.use((req, _res, next) => {
      req.session = user ? { localUserId: user.id } : {};
      next();
    });
    application.use(load('src/middleware/authMiddleware'));
    application.use('/api/shares', load('src/routes/shares'));
    application.use('/api/share', load('src/routes/shares'));
    application.use(load('src/middleware/errorHandler').errorHandler);
    return application;
  };

  it('keeps what a visitor replaces, for the owner to find', async () => {
    const assignedRoot = path.join(env.tmpRoot, 'assigned');
    await fs.mkdir(assignedRoot, { recursive: true });
    await fs.writeFile(path.join(assignedRoot, 'minutes.txt'), 'as written by the owner');
    const owner = await load('src/services/users').createLocalUser({
      email: 'owner@example.com',
      username: 'owner',
      displayName: 'Owner',
      password: 'secret123',
      roles: ['user'],
    });
    await load('src/services/userVolumesService').addVolumeToUser({
      userId: owner.id,
      label: 'Assigned',
      volumePath: assignedRoot,
      accessMode: 'readwrite',
    });
    const create = await request(buildApp({ user: owner }))
      .post('/api/shares')
      .send({
        sourcePath: 'Assigned/minutes.txt',
        accessMode: 'readwrite',
        sharingType: 'anyone',
      });
    expect(create.status).toBe(201);

    const save = await request(buildApp())
      .put(`/api/share/${create.body.shareToken}/editor`)
      .send({ content: 'amended by a visitor' });

    expect(save.status).toBe(200);
    expect(await fs.readFile(path.join(assignedRoot, 'minutes.txt'), 'utf8')).toBe(
      'amended by a visitor'
    );
    const [version] = await versionsUnder(assignedRoot, 'minutes.txt');
    expect(version).toMatchObject({ content: 'as written by the owner', source: 'external' });

    await request(buildApp())
      .put(`/api/share/${create.body.shareToken}/editor`)
      .send({ content: 'amended again' });
    const [newest] = await versionsUnder(assignedRoot, 'minutes.txt');
    expect(newest).toMatchObject({
      content: 'amended by a visitor',
      authorId: null,
      authorLabel: 'share-link',
      source: 'share-editor',
    });
  });
});
