import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/db',
  'src/services/settingsService',
  'src/services/accessControlService',
  'src/services/accessManager',
  'src/services/authorizationService',
  'src/services/sharesService',
  'src/services/tusUploadService',
  'src/services/userVolumesService',
  'src/routes/upload',
  'src/middleware/errorHandler',
  'src/utils/pathUtils',
];

const encodeMetadata = (metadata) =>
  Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');

const startServer = (server) =>
  new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });

describe('TUS upload route', () => {
  let envContext;

  beforeEach(async () => {
    envContext = await setupTestEnv({
      tag: 'tus-upload-test-',
      modules: MODULES,
    });
  });

  afterEach(async () => {
    await envContext.cleanup();
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

  it('rejects TUS uploads when chunked uploads are disabled', async () => {
    const server = buildApp();
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '5')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'hello.txt',
            relativePath: 'S05E09 - Épisode 9.avi',
            uploadTo: 'Nvm',
          })
        );

      expect(response.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('stores a completed TUS upload in the authorized target directory', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
    const server = buildApp();
    const baseUrl = await startServer(server);
    const content = Buffer.from('hello through tus');

    try {
      const create = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(content.length))
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'hello.txt',
            relativePath: 'S05E09 - Épisode 9.avi',
            uploadTo: 'Nvm',
          })
        );

      expect(create.status).toBe(201);
      expect(create.headers.location).toBeTruthy();

      const uploadPath = new URL(create.headers.location).pathname;
      const patch = await request(baseUrl)
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(content);

      expect(patch.status).toBe(204);
      await expect(
        fs.readFile(path.join(envContext.volumeDir, 'Nvm', 'S05E09 - Épisode 9.avi'), 'utf8')
      ).resolves.toBe('hello through tus');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects TUS upload creation when storage is insufficient', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
    const statfsSpy = vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: 1,
      bsize: 1024,
    });

    const server = buildApp();
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(1024 * 1024))
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'large.bin',
            relativePath: 'large.bin',
            uploadTo: 'Nvm',
          })
        );

      expect(response.status).toBe(507);
      expect(response.text).toContain('Not enough storage available');
    } finally {
      statfsSpy.mockRestore();
      await closeServer(server);
    }
  });
});
