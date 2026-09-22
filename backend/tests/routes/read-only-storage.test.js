import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A folder the storage will not let the server write in.
 *
 * A volume bound `:ro` in a compose file, or owned by a user the container does
 * not run as, was offered New folder, Upload and Delete like any other — to an
 * administrator above all, whom no rule restricts — and every one of them ended
 * in the system's refusal once it had been chosen (nxzai/NextExplorer#407).
 * The listing and the list of volumes now ask the system first, and a write
 * that still reaches a read-only mount is answered in words.
 *
 * A read-only mount cannot be made in a test, so `EROFS` is answered by the
 * one call that asks; a folder the server may not write in is real, made with
 * its mode, and only where the tests do not run as root — root writes through
 * any mode, which is also what the check reports for it.
 */

const require = createRequire(import.meta.url);
const fsCallbacks = require('fs');

let env;
const locked = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (locked.length) await fs.chmod(locked.pop(), 0o755).catch(() => {});
  if (env) await env.cleanup();
  env = null;
});

const ADMIN = { id: 'admin-1', roles: ['admin'] };
const REGULAR = { id: 'user-1', roles: ['user'] };
const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const seed = async (extraEnv = {}) => {
  env = await setupTestEnv({ tag: 'read-only-storage-', env: extraEnv });
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
  for (const name of ['Media', 'Archive', 'Locked']) {
    await fs.mkdir(path.join(env.volumeDir, name), { recursive: true });
  }
  await fs.writeFile(path.join(env.volumeDir, 'Archive', 'film.mkv'), 'x');
};

/** The volume behind `name` answers as a read-only mount does. */
const mountedReadOnly = (name) => {
  const target = path.join(env.volumeDir, name);
  const original = fsCallbacks.promises.access;
  vi.spyOn(fsCallbacks.promises, 'access').mockImplementation(async (file, mode) => {
    // Only a write is refused: a mount read-only still exists and still reads.
    if (path.resolve(String(file)) === target && mode & fsCallbacks.constants.W_OK) {
      throw Object.assign(new Error(`EROFS: read-only file system, access '${file}'`), {
        code: 'EROFS',
      });
    }
    return original(file, mode);
  });
};

/** The volume behind `name` is one the server's user may not write in. */
const lockedFor = async (name) => {
  const target = path.join(env.volumeDir, name);
  await fs.chmod(target, 0o555);
  locked.push(target);
};

const app = (routeModule, user) => {
  const routes = env.requireFresh(routeModule);
  const { errorHandler } = env.requireFresh('src/middleware/errorHandler');
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/api', routes);
  server.use(errorHandler);
  return server;
};

const WRITES = ['canWrite', 'canUpload', 'canDelete', 'canCreateFolder', 'canCreateFile'];

describe('a folder on a read-only mount', () => {
  it('offers no write to anyone, an administrator included, and says why', async () => {
    await seed();
    mountedReadOnly('Archive');

    for (const user of [ADMIN, REGULAR]) {
      const response = await request(app('src/routes/browse', user)).get('/api/browse/Archive');

      expect(response.status).toBe(200);
      // Still read: only the writes go.
      expect(response.body.items.map((item) => item.name)).toEqual(['film.mkv']);
      for (const key of WRITES) expect(response.body.access[key]).toBe(false);
      expect(response.body.access.canDownload).toBe(true);
      expect(response.body.access.readOnly).toBe('storage');
    }
  });

  it('leaves a folder the storage lets the server write in as it was', async () => {
    await seed();
    mountedReadOnly('Archive');

    const response = await request(app('src/routes/browse', ADMIN)).get('/api/browse/Media');

    for (const key of WRITES) expect(response.body.access[key]).toBe(true);
    expect(response.body.access.readOnly).toBeNull();
  });

  it('answers a write that still reaches it in words, not as a server fault', async () => {
    await seed();
    const server = express();
    server.post('/api/write', () => {
      throw Object.assign(new Error("EROFS: read-only file system, mkdir '/mnt/torrents/x'"), {
        code: 'EROFS',
      });
    });
    server.use(env.requireFresh('src/middleware/errorHandler').errorHandler);

    const response = await request(server).post('/api/write');

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe(
      'This storage is read-only: nothing can be written here.'
    );
  });
});

describe.skipIf(runsAsRoot)('a folder the server may not write in', () => {
  it('offers no write, and says it is the permission', async () => {
    await seed();
    await lockedFor('Locked');

    const response = await request(app('src/routes/browse', ADMIN)).get('/api/browse/Locked');

    for (const key of WRITES) expect(response.body.access[key]).toBe(false);
    expect(response.body.access.readOnly).toBe('permission');
  });
});

describe('the volumes, as the home page and the sidebar list them', () => {
  it('mark a read-only mount, and only that one', async () => {
    await seed();
    mountedReadOnly('Archive');

    const response = await request(app('src/routes/volumes', ADMIN)).get('/api/volumes');

    const byName = Object.fromEntries(response.body.map((v) => [v.name, v.readOnly]));
    expect(byName.Archive).toBe('storage');
    expect(byName.Media).toBeNull();
  });

  it.skipIf(runsAsRoot)('mark a volume the server may not write in', async () => {
    await seed();
    await lockedFor('Locked');

    const response = await request(app('src/routes/volumes', ADMIN)).get('/api/volumes');

    expect(response.body.find((v) => v.name === 'Locked').readOnly).toBe('permission');
  });

  it('mark a volume a rule makes read-only for the account asking, not for an administrator', async () => {
    await seed();
    await env
      .requireFresh('src/services/accessControlService')
      .setRules([{ path: 'Media', recursive: true, permissions: 'ro' }]);

    const regular = await request(app('src/routes/volumes', REGULAR)).get('/api/volumes');
    const admin = await request(app('src/routes/volumes', ADMIN)).get('/api/volumes');

    expect(regular.body.find((v) => v.name === 'Media').readOnly).toBe('access');
    // A read-only rule does not restrict an administrator, and saying it does
    // would be the mark lying.
    expect(admin.body.find((v) => v.name === 'Media').readOnly).toBeNull();
  });

  it('mark a volume assigned read-only to the account asking', async () => {
    await seed({ USER_VOLUMES: 'true' });
    const userVolumes = env.requireFresh('src/services/userVolumesService');
    await userVolumes.addVolumeToUser({
      userId: 'user-1',
      label: 'Films',
      volumePath: path.join(env.volumeDir, 'Archive'),
      accessMode: 'readonly',
    });
    await userVolumes.addVolumeToUser({
      userId: 'user-1',
      label: 'Travail',
      volumePath: path.join(env.volumeDir, 'Media'),
      accessMode: 'readwrite',
    });

    const response = await request(app('src/routes/volumes', REGULAR)).get('/api/volumes');

    const byName = Object.fromEntries(response.body.map((v) => [v.name, v.readOnly]));
    expect(byName).toEqual({ Films: 'access', Travail: null });
  });

  it('put the mount before the account when both would say so', async () => {
    await seed({ USER_VOLUMES: 'true' });
    await env.requireFresh('src/services/userVolumesService').addVolumeToUser({
      userId: 'user-1',
      label: 'Films',
      volumePath: path.join(env.volumeDir, 'Archive'),
      accessMode: 'readonly',
    });
    mountedReadOnly('Archive');

    const response = await request(app('src/routes/volumes', REGULAR)).get('/api/volumes');

    // The mount holds for everyone; the assignment would change nothing.
    expect(response.body[0].readOnly).toBe('storage');
  });
});
