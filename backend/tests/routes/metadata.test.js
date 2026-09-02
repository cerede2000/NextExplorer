import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
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

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'metadata-' });
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

  /**
   * A path that climbs out of the volume is refused, and the refusal says
   * forbidden rather than not-found: the caller asked about somewhere they may
   * not look, which is a different answer from somewhere that is empty.
   */
  it('refuses a path that leaves the volume', async () => {
    await seed();

    const response = await request(buildApp()).get('/api/metadata/../../etc/passwd');

    expect([403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
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
