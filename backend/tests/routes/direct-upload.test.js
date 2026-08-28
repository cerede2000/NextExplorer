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
      // The temporary file it was written through is gone.
      expect(await exists(path.join(destination, 'hello.txt.uploading'))).toBe(false);
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
