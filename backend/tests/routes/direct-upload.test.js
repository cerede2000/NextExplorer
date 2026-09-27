import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The default upload path — `UPLOAD_CHUNKED_ENABLED` is false out of the box,
 * so this is what nearly every deployment runs, and until now it had no test of
 * its own. What it guards: an upload the volume cannot hold, and the remains of
 * one that was killed.
 */

let envContext;

const startServer = (server) =>
  new Promise((resolve) => {
    server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });

const buildApp = () => {
  const express = require('express');
  const http = require('node:http');
  const uploadRoutes = envContext.requireFresh('src/routes/upload');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin', email: 'admin@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', uploadRoutes);
  app.use(errorHandler);
  return http.createServer(app);
};

/** An authorised destination, and a server pointing at it. */
const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'direct-upload-test-', env });
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });
  return { destination, server: buildApp() };
};

const upload = (baseUrl, { name = 'hello.txt', content = 'hello' } = {}) =>
  request(baseUrl)
    .post('/api/upload')
    .query({ uploadTo: 'Nvm', relativePath: name })
    .attach('filedata', Buffer.from(content), name);

/**
 * The same upload, sent without a Content-Length: node writes the body chunked
 * when it is not told how long it is, which is what a client streaming a file
 * does and what supertest never does.
 */
const uploadWithoutContentLength = (baseUrl, name) => {
  const http = require('node:http');
  const boundary = 'direct-upload-no-length';
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/upload?uploadTo=Nvm&relativePath=${encodeURIComponent(name)}`,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="filedata"; filename="${name}"\r\n` +
        'Content-Type: text/plain\r\n\r\n'
    );
    req.write('a few bytes');
    req.end(`\r\n--${boundary}--\r\n`);
  });
};

const exists = async (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a direct upload', () => {
  it('lands in the authorised folder', async () => {
    const { destination, server } = await build();
    const baseUrl = await startServer(server);

    try {
      const response = await upload(baseUrl, { name: 'hello.txt', content: 'hello there' });

      expect(response.status).toBe(200);
      expect(await fs.readFile(path.join(destination, 'hello.txt'), 'utf8')).toBe('hello there');
      // The temporary file it was written through is gone, whatever its name.
      expect(await fs.readdir(destination)).toEqual(['hello.txt']);
    } finally {
      await closeServer(server);
    }
  });

  // A full volume takes the database down with it where `/config` shares the
  // filesystem, so the refusal has to happen before anything is written.
  it('is refused with 507 when the volume cannot hold it', async () => {
    const { destination, server } = await build({ UPLOAD_STORAGE_RESERVE: '900T' });
    const baseUrl = await startServer(server);

    try {
      const response = await upload(baseUrl, { name: 'too-big.bin' });

      expect(response.status).toBe(507);
      expect(await exists(path.join(destination, 'too-big.bin'))).toBe(false);
      expect(await exists(path.join(destination, 'too-big.bin.uploading'))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  /**
   * An upload that announces no size at all.
   *
   * The only measure of what is coming is Content-Length, and a request sent
   * chunked has none — what an API client streaming a file does. The guard
   * takes a number and was handed nothing, so it returned without looking:
   * this upload landed on a volume the one above it was refused on. Zero is
   * what is honestly known about what is coming, and the reserve is still held
   * free, which is the part that keeps the database alive.
   */
  it('is refused when it announces no size and the reserve is already gone', async () => {
    const { destination, server } = await build({ UPLOAD_STORAGE_RESERVE: '900T' });
    const baseUrl = await startServer(server);

    try {
      const status = await uploadWithoutContentLength(baseUrl, 'streamed.txt');

      expect(status).toBe(507);
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  /** And one that announces nothing still lands where there is room for it. */
  it('is accepted when it announces no size and there is room', async () => {
    const { destination, server } = await build();
    const baseUrl = await startServer(server);

    try {
      const status = await uploadWithoutContentLength(baseUrl, 'streamed.txt');

      expect(status).toBe(200);
      expect(await fs.readdir(destination)).toEqual(['streamed.txt']);
    } finally {
      await closeServer(server);
    }
  });

  it('clears the remains of a killed upload from the folder it writes to', async () => {
    const { destination, server } = await build();
    const stale = path.join(destination, 'holiday.mp4.uploading');
    await fs.writeFile(stale, 'half a film');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo);

    const recent = path.join(destination, 'still-going.mkv.uploading');
    await fs.writeFile(recent, 'in flight');

    const baseUrl = await startServer(server);

    try {
      const response = await upload(baseUrl, { name: 'notes.txt' });

      expect(response.status).toBe(200);
      expect(await exists(stale)).toBe(false);
      // Another upload writing right now is not remains.
      expect(await exists(recent)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});

/**
 * What multer refuses is the request's doing, not the server's. Its errors carry
 * no status, and every one of them used to answer 500 and log a server error.
 * The limit is named along with the setting that raises it, because "File too
 * large" leaves whoever reads it nowhere to go.
 */
describe('a direct upload over the limits', () => {
  it('is refused with 413 when the file is larger than MAX_DIRECT_UPLOAD_SIZE, and leaves nothing', async () => {
    const { destination, server } = await build({ MAX_DIRECT_UPLOAD_SIZE: '1K' });
    const baseUrl = await startServer(server);

    try {
      const response = await upload(baseUrl, { name: 'big.bin', content: 'x'.repeat(4096) });

      expect(response.status).toBe(413);
      expect(response.body.error.message).toBe(
        'This file is larger than the 1 KB a direct upload accepts. Use chunked uploads, or raise MAX_DIRECT_UPLOAD_SIZE.'
      );
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('is refused with 413 when one request carries more than MAX_FILES_PER_UPLOAD files', async () => {
    const { destination, server } = await build({ MAX_FILES_PER_UPLOAD: '2' });
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .post('/api/upload')
        .query({ uploadTo: 'Nvm' })
        .attach('filedata', Buffer.from('one'), 'one.txt')
        .attach('filedata', Buffer.from('two'), 'two.txt')
        .attach('filedata', Buffer.from('three'), 'three.txt');

      expect(response.status).toBe(413);
      expect(response.body.error.message).toBe(
        'One upload request takes at most 2 files. Send the others in another, or raise MAX_FILES_PER_UPLOAD.'
      );
      // The files that arrived before the refusal are taken back with it.
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('is refused with 400 when the file comes in a field the route does not read', async () => {
    const { destination, server } = await build();
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .post('/api/upload')
        .query({ uploadTo: 'Nvm', relativePath: 'stray.txt' })
        .attach('attachment', Buffer.from('stray'), 'stray.txt');

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe(
        'A file was sent in a field this request does not take.'
      );
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
