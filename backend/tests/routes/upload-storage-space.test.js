import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * An upload that cannot fit.
 *
 * A full volume is not only a failed upload. Where `/config` sits on the same
 * filesystem — the ordinary single-volume deployment — SQLite stops being able
 * to write and the whole application stops working, for everybody rather than
 * for the person uploading. So the room is asked about before a byte is
 * written, and `UPLOAD_STORAGE_RESERVE` is the cushion kept free.
 */

const fsp = require('fs/promises');

let envContext;
/** Free bytes the filesystem claims to have. */
let free;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const seed = async ({ reserve = '0' } = {}) => {
  envContext = await setupTestEnv({
    tag: 'upload-space-',
    env: { UPLOAD_STORAGE_RESERVE: reserve },
  });
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });
  vi.spyOn(fsp, 'statfs').mockImplementation(async () => ({
    bavail: free,
    bsize: 1,
    blocks: 1_000_000_000,
  }));
  return destination;
};

const buildApp = () => {
  const routes = envContext.requireFresh('src/routes/upload');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

const upload = (app, content) =>
  request(app)
    .post('/api/upload')
    .field('uploadTo', 'Nvm')
    .field('relativePath', 'film.bin')
    .attach('filedata', Buffer.from(content), 'film.bin');

describe('uploading into a volume with little left', () => {
  it('is refused before anything is written, and says why', async () => {
    const destination = await seed();
    free = 10;

    const response = await upload(buildApp(), 'x'.repeat(4096));

    expect(response.status).toBe(507);
    // Not even the hidden file the bytes would have gone through.
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('goes through when there is room for it', async () => {
    const destination = await seed();
    free = 10 * 1024 * 1024;

    const response = await upload(buildApp(), 'x'.repeat(4096));

    expect(response.status).toBe(200);
    expect(await fs.readdir(destination)).toEqual(['film.bin']);
  });

  /**
   * The reserve is what the database needs to keep working. An upload that
   * would fit exactly, leaving nothing, is the one that takes the instance
   * down with it.
   */
  it('keeps the reserve free, even for an upload that would otherwise fit', async () => {
    const destination = await seed({ reserve: '1M' });
    free = 512 * 1024;

    const response = await upload(buildApp(), 'x'.repeat(1024));

    expect(response.status).toBe(507);
    expect(await fs.readdir(destination)).toEqual([]);
  });

  /** A filesystem that cannot be measured is not a reason to refuse anybody. */
  it('lets the upload through where the free space cannot be read', async () => {
    const destination = await seed();
    fsp.statfs.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOSYS' }));

    const response = await upload(buildApp(), 'x'.repeat(1024));

    expect(response.status).toBe(200);
    expect(await fs.readdir(destination)).toEqual(['film.bin']);
  });
});
