import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The editor refuses to open a file past `EDITOR_MAX_FILESIZE`, and used to
 * save anything it was handed. Paste two megabytes into a small file, save,
 * and the next attempt to open it answered "This file is too large to open in
 * the text editor" — a file written by the editor that the editor would not
 * take back.
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

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'editor-save-test-', env });
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });

  const express = require('express');
  const http = require('node:http');
  const { uploads } = envContext.requireFresh('src/config/index');
  const editorRoutes = envContext.requireFresh('src/routes/editor');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: uploads.maxJsonBodyBytes }));
  app.use((req, _res, next) => {
    req.user = { id: 'admin', email: 'admin@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', editorRoutes);
  app.use(errorHandler);

  return { destination, server: http.createServer(app) };
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

describe('saving from the text editor', () => {
  it('writes what fits', async () => {
    const { destination, server } = await build({ EDITOR_MAX_FILESIZE: '64K' });
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/notes.md', content: '# Notes\n\nA short document.\n' });

      expect(response.status).toBe(200);
      expect(await fs.readFile(path.join(destination, 'notes.md'), 'utf8')).toContain('A short');
    } finally {
      await closeServer(server);
    }
  });

  it('refuses what it would not be able to open again', async () => {
    const { destination, server } = await build({ EDITOR_MAX_FILESIZE: '4K' });
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/big.md', content: 'x'.repeat(5 * 1024) });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/too large to save/i);
      // Nothing written: the refusal comes before the file is touched.
      expect(await exists(path.join(destination, 'big.md'))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('says nothing about size for a document at the limit', async () => {
    const { server } = await build({ EDITOR_MAX_FILESIZE: '4K' });
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/exact.md', content: 'x'.repeat(4 * 1024) });

      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  // What the reporter of nxzai#368 saw, and could do nothing with. The body
  // limit is the smallest the pair allows, so the request is refused before it
  // ever reaches the route.
  it('tells a request that is too big which setting governs it', async () => {
    const { server } = await build({ EDITOR_MAX_FILESIZE: '64K', MAX_JSON_BODY_SIZE: '1M' });
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/huge.md', content: 'x'.repeat(3 * 1024 * 1024) });

      expect(response.status).toBe(413);
      expect(response.body.error.message).toMatch(/MAX_JSON_BODY_SIZE/);
      expect(response.body.error.message).not.toMatch(/request entity too large/i);
    } finally {
      await closeServer(server);
    }
  });
});
