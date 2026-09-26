import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the top level holds is not a folder in the storage.
 *
 * A volume is a mount the server was given — usually somebody's data, shared
 * with other programs — and the personal folder and an assigned volume are the
 * same kind of thing. Creating one was refused; renaming and deleting one were
 * not, so a single call renamed a mount or removed it and everything under it,
 * with `GET /api/volumes` answering an empty list afterwards. The interface
 * offers neither, which is why it went unseen: only a direct call reached them
 * (nxzai/NextExplorer#409).
 *
 * Moving one out of the list is the same loss as deleting it, and an upload
 * started from the list made a folder there — a volume of its own — which
 * creating a folder there has always refused.
 */

let env;

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const REGULAR = { id: 'user-1', roles: ['user'] };

const volumeDir = (...parts) => path.join(env.volumeDir, ...parts);

const seed = async (extraEnv = {}) => {
  env = await setupTestEnv({ tag: 'volume-root-', env: extraEnv });
  const db = await env.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  for (const [id, username, roles] of [
    ['admin-1', 'admin', '["admin"]'],
    ['user-1', 'regular', '["user"]'],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, `${username}@example.com`, username, username, roles, now, now);
  }
  await fs.mkdir(volumeDir('Files', 'inside'), { recursive: true });
  await fs.mkdir(volumeDir('Autre'), { recursive: true });
  await fs.writeFile(volumeDir('Files', 'inside', 'data.txt'), 'what somebody keeps here\n');
};

const app = (routeModule, user = ADMIN) => {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/api', env.requireFresh(routeModule));
  server.use(env.requireFresh('src/middleware/errorHandler').errorHandler);
  return server;
};

const files = (user) => app('src/routes/files', user);
const refusal = (response) => response.body?.error?.message || '';

/** Nothing of the volume, or of what it holds, has moved. */
const volumesUntouched = async () => {
  expect((await fs.readdir(env.volumeDir)).sort()).toEqual(['Autre', 'Files']);
  expect(await fs.readFile(volumeDir('Files', 'inside', 'data.txt'), 'utf8')).toBe(
    'what somebody keeps here\n'
  );
};

beforeEach(async () => {
  await seed();
});

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

describe('a volume, asked about from the list of volumes', () => {
  it('is not renamed, whoever asks', async () => {
    for (const user of [ADMIN, REGULAR]) {
      const response = await request(files(user))
        .post('/api/files/rename')
        .send({ path: '', name: 'Files', newName: 'Renamed' });

      expect(response.status).toBe(400);
      expect(refusal(response)).toContain('cannot be renamed here');
    }
    await volumesUntouched();
  });

  it('is not deleted, by any of the three ways to ask', async () => {
    const asks = [
      request(files())
        .delete('/api/files')
        .send({ items: [{ path: '', name: 'Files' }] }),
      request(files())
        .delete('/api/files')
        .send({ items: [{ path: '', name: 'Files' }], permanent: true }),
      request(files())
        .post('/api/files/delete-stream')
        .send({ items: [{ path: '', name: 'Files' }], permanent: true }),
    ];

    for (const ask of asks) {
      const response = await ask;
      expect(response.status).toBe(400);
      expect(refusal(response)).toContain('cannot be deleted here');
    }
    await volumesUntouched();
  });

  /** The confirmation asks first what a deletion would take; it refuses too. */
  it('is not counted for a deletion either', async () => {
    const response = await request(files())
      .post('/api/files/delete-impact')
      .send({ items: [{ path: '', name: 'Files' }] });

    expect(response.status).toBe(400);
    expect(refusal(response)).toContain('cannot be deleted here');
  });

  it('is neither moved nor copied into another volume', async () => {
    for (const [operation, said] of [
      ['move', 'cannot be moved here'],
      ['copy', 'cannot be copied here'],
    ]) {
      const response = await request(files())
        .post(`/api/files/${operation}`)
        .send({ items: [{ path: '', name: 'Files' }], destination: 'Autre' });

      expect(response.status).toBe(400);
      expect(refusal(response)).toContain(said);
    }
    await volumesUntouched();
    expect(await fs.readdir(volumeDir('Autre'))).toEqual([]);
  });

  /** The refusal the others were missing, and which has always been there. */
  it('is not created from here either', async () => {
    const response = await request(files())
      .post('/api/files/folder')
      .send({ path: '', name: 'Music' });

    expect(response.status).toBe(400);
    await volumesUntouched();
  });
});

describe('what is inside a volume', () => {
  it('is still renamed, deleted, moved and copied', async () => {
    const renamed = await request(files())
      .post('/api/files/rename')
      .send({ path: 'Files', name: 'inside', newName: 'dedans' });
    expect(renamed.status).toBe(200);

    const copied = await request(files())
      .post('/api/files/copy')
      .send({ items: [{ path: 'Files', name: 'dedans' }], destination: 'Autre' });
    expect(copied.status).toBe(200);

    const moved = await request(files())
      .post('/api/files/move')
      .send({ items: [{ path: 'Files', name: 'dedans' }], destination: 'Autre' });
    expect(moved.status).toBe(200);

    const deleted = await request(files())
      .delete('/api/files')
      .send({ items: [{ path: 'Autre', name: 'dedans' }], permanent: true });
    expect(deleted.status).toBe(200);

    expect(await fs.readdir(volumeDir('Files'))).toEqual([]);
    // The copy landed under a name of its own, and outlived the move.
    expect((await fs.readdir(volumeDir('Autre'))).length).toBe(1);
  });
});

describe('the personal folder', () => {
  it('is neither renamed nor deleted from the list', async () => {
    await env.cleanup();
    await seed({ USER_DIR_ENABLED: 'true' });

    const renamed = await request(files())
      .post('/api/files/rename')
      .send({ path: '', name: 'personal', newName: 'perso' });
    const deleted = await request(files())
      .delete('/api/files')
      .send({ items: [{ path: '', name: 'personal' }], permanent: true });

    expect(renamed.status).toBe(400);
    expect(refusal(renamed)).toContain('cannot be renamed here');
    expect(deleted.status).toBe(400);
    expect(refusal(deleted)).toContain('cannot be deleted here');
  });
});

describe('a volume assigned to an account', () => {
  it('is not deleted by the account it was assigned to', async () => {
    await env.cleanup();
    await seed({ USER_VOLUMES: 'true' });
    await env.requireFresh('src/services/userVolumesService').addVolumeToUser({
      userId: 'user-1',
      label: 'Travail',
      volumePath: volumeDir('Files'),
      accessMode: 'readwrite',
    });

    const response = await request(files(REGULAR))
      .delete('/api/files')
      .send({ items: [{ path: '', name: 'Travail' }], permanent: true });

    expect(response.status).toBe(400);
    expect(refusal(response)).toContain('cannot be deleted here');
    await volumesUntouched();
  });
});

describe('an upload started from the list of volumes', () => {
  const upload = (query, name = 'planted.txt') =>
    request(app('src/routes/upload'))
      .post('/api/upload')
      .query(query)
      .attach('filedata', Buffer.from('planted'), name);

  /**
   * The file itself was already refused; the folder of its own relative path
   * was not, and a folder at the top is a volume.
   */
  it('makes no volume of the folder it carries', async () => {
    const response = await upload({ uploadTo: '', relativePath: 'NouveauVolume/planted.txt' });

    expect(response.status).toBe(400);
    expect(refusal(response)).toContain('root path');
    expect((await fs.readdir(env.volumeDir)).sort()).toEqual(['Autre', 'Files']);
  });

  it('still carries its folders inside a volume', async () => {
    const response = await upload({ uploadTo: 'Files', relativePath: 'sous/planted.txt' });

    expect(response.status).toBe(200);
    expect(await fs.readFile(volumeDir('Files', 'sous', 'planted.txt'), 'utf8')).toBe('planted');
  });
});
