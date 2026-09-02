import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The details panel. Its own work is small — a stat, an extension, and a
 * recursive sum for a folder — and none of it was covered: 18.8 % of the
 * statements and not one branch. The sum is the part worth pinning, because a
 * folder's size is the number people act on.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async (env = {}) => {
  currentEnv = await setupTestEnv({ tag: 'metadata-', env });
  const dbService = currentEnv.requireFresh('src/services/db');
  const db = await dbService.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1','u@example.com',1,'u','U','["admin"]', ?, ?)`
  ).run(now, now);
  return currentEnv.volumeDir;
};

const buildApp = () => {
  const routes = currentEnv.requireFresh('src/routes/metadata');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', email: 'u@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

describe('reading a file’s details', () => {
  it('reports the name, kind and size', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Docs', 'note.txt'), 'hello world\n');

    const response = await request(buildApp()).get('/api/metadata/Docs/note.txt');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      path: 'Docs/note.txt',
      name: 'note.txt',
      kind: 'txt',
      size: 12,
    });
  });

  it('calls a file without an extension unknown rather than empty', async () => {
    const volume = await seed();
    await fs.writeFile(path.join(volume, 'LICENSE'), 'text\n');

    const response = await request(buildApp()).get('/api/metadata/LICENSE');

    expect(response.body.kind).toBe('unknown');
  });

  it('requires a path', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/metadata/');

    expect(response.status).toBe(400);
  });

  it('says not found for a path that is not there', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/metadata/Docs/absent.txt');

    expect(response.status).toBe(404);
  });

  it('refuses a path that leaves the volume', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/metadata/../../etc/passwd');

    expect([403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  /**
   * The refusal says forbidden rather than not-found: the caller asked about
   * somewhere they may not look, which is a different answer from somewhere
   * that is empty — and the details panel shows a different message for each.
   *
   * Reached with USER_VOLUMES on and nothing assigned, so the path resolves and
   * exists and only the access check says no. A path that climbs out of the
   * volume never gets there: it is refused while being resolved, which is why
   * the test above proves nothing about this branch.
   */
  it('says forbidden for a file the caller may not read', async () => {
    const volume = await seed({ USER_VOLUMES: 'true' });
    await fs.mkdir(path.join(volume, 'Private'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Private', 'secret.txt'), 'x');

    const routes = currentEnv.requireFresh('src/routes/metadata');
    const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'restricted', roles: [] };
      next();
    });
    app.use('/api', routes);
    app.use(errorHandler);

    const response = await request(app).get('/api/metadata/Private/secret.txt');

    expect(response.status).toBe(403);
  });
});

describe('summing what a folder holds', () => {
  const buildTree = async (volume) => {
    await fs.mkdir(path.join(volume, 'Tree', 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Tree', 'one.txt'), 'x'.repeat(10));
    await fs.writeFile(path.join(volume, 'Tree', 'a', 'two.txt'), 'x'.repeat(20));
    await fs.writeFile(path.join(volume, 'Tree', 'a', 'b', 'three.txt'), 'x'.repeat(30));
  };

  it('counts every file under the folder, not only the top level', async () => {
    const volume = await seed();
    await buildTree(volume);

    const response = await request(buildApp()).get('/api/metadata/Tree');

    expect(response.status).toBe(200);
    expect(response.body.directory).toMatchObject({
      totalSize: 60,
      fileCount: 3,
      dirCount: 2,
      truncated: false,
    });
  });

  it('says a folder is a directory rather than guessing at an extension', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'archive.zip'), { recursive: true });

    const response = await request(buildApp()).get('/api/metadata/archive.zip');

    expect(response.body.kind).toBe('directory');
  });

  it('reports an empty folder as empty rather than failing', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Empty'), { recursive: true });

    const response = await request(buildApp()).get('/api/metadata/Empty');

    expect(response.status).toBe(200);
    expect(response.body.directory).toMatchObject({ totalSize: 0, fileCount: 0, dirCount: 0 });
  });

  /**
   * A broken symbolic link cannot be stat'ed. One of them must not cost the
   * whole total — the answer people read is the sum of what could be counted.
   */
  it('skips what it cannot read and still returns a total', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Mixed'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Mixed', 'real.txt'), 'x'.repeat(15));
    await fs.symlink(
      path.join(volume, 'Mixed', 'gone.txt'),
      path.join(volume, 'Mixed', 'dangling')
    );

    const response = await request(buildApp()).get('/api/metadata/Mixed');

    expect(response.status).toBe(200);
    expect(response.body.directory).toMatchObject({ totalSize: 15, fileCount: 1 });
  });
});

/**
 * What a picture and a film say about themselves.
 *
 * Both branches read a third-party library — sharp for images, ffprobe for
 * video — and both are wrapped so a file that cannot be read does not cost the
 * caller the rest of the answer. That wrapping is the part worth pinning: the
 * details panel still has a name, a size and a date to show for a photo whose
 * header is damaged.
 */
describe('a picture', () => {
  const writeImage = async (volume, name, { width, height }) => {
    const file = path.join(volume, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 80, b: 120 } },
    })
      .png()
      .toFile(file);
  };

  it('reports the size it was taken at', async () => {
    const volume = await seed();
    await writeImage(volume, 'Photos/one.png', { width: 48, height: 32 });

    const response = await request(buildApp()).get('/api/metadata/Photos/one.png');

    expect(response.status).toBe(200);
    expect(response.body.image).toMatchObject({ width: 48, height: 32 });
  });

  /**
   * A file named `.png` that is not one. The panel loses the picture's own
   * details and keeps everything the filesystem knows, which is what somebody
   * looking at a damaged file most needs.
   */
  it('still answers when the file is not the picture it claims to be', async () => {
    const volume = await seed();
    await fs.mkdir(path.join(volume, 'Photos'), { recursive: true });
    await fs.writeFile(path.join(volume, 'Photos', 'broken.png'), 'not a png at all');

    const response = await request(buildApp()).get('/api/metadata/Photos/broken.png');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'broken.png', kind: 'png', size: 16 });
  });
});
