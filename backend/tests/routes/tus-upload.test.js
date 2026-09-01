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

/** Sign in far enough to hold a session cookie, the way a browser does. */
const establishSession = async (baseUrl) => {
  const response = await request(baseUrl).get('/api/test-session');
  const cookies = response.headers['set-cookie'];
  if (!cookies?.length) throw new Error('no session cookie was issued');
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
};

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
    // A real session, deliberately: a route suite that mounts none is exercising
    // a stack nobody runs. The seam it puts back — express-session replaces
    // `res.end` with a version that reads the callback @tus/server passes as a
    // body, which is what crashed the server before 3.0.2 — has a guard of its
    // own in tests/middleware/response-end-compat.test.js. This does not
    // replace it: removing the fix leaves these green.
    const { configureSession } = envContext.requireFresh('src/middleware/session');
    configureSession(app);
    // Something has to be written to the session for one to exist: the store's
    // `touch` — the path the crash went through — only runs for a session that
    // is already established and unmodified.
    app.get('/api/test-session', (req, res) => {
      req.session.establishedAt = new Date().toISOString();
      res.json({ ok: true });
    });
    app.use((req, _res, next) => {
      req.user = { id: 'admin', email: 'admin@example.com', roles: ['admin'] };
      next();
    });
    app.use('/api', uploadRoutes);
    app.use(errorHandler);
    return http.createServer(app);
  };

  // Both switches, not one. TUS carries forced chunking *and* the client-side
  // automatic fallback, so it is refused only when neither is on — which the
  // old name of this case ("when chunked uploads are disabled") did not say,
  // leaving the more interesting half untested below.
  it('refuses an upload when neither forced chunking nor the fallback is on', async () => {
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);

    try {
      const response = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
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
      // The status alone would be satisfied by any refusal — an unmounted
      // route, a failed authorisation. This is the one being tested.
      expect(String(response.text)).toMatch(/chunked uploads are disabled/i);
    } finally {
      await closeServer(server);
    }
  });

  // The gate reads `chunkedEnabled || chunkedAutoFallback`, and the fallback
  // half had no test. Getting it wrong once already rejected every fallback
  // upload with a 403 that reached the client as "network error".
  it('accepts an upload when only the automatic fallback is on', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: false,
      chunkedAutoFallback: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);

    try {
      const response = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '5')
        .set(
          'Upload-Metadata',
          encodeMetadata({ filename: 'hello.txt', relativePath: 'hello.txt', uploadTo: 'Nvm' })
        );

      expect(response.status).toBe(201);
      expect(response.headers.location).toBeTruthy();
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
    const cookie = await establishSession(baseUrl);
    const content = Buffer.from('hello through tus');

    try {
      const create = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
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
    const cookie = await establishSession(baseUrl);

    try {
      const response = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
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

  it('cleans stale incomplete TUS uploads from the cache', async () => {
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    await fs.mkdir(tusDir, { recursive: true });

    const staleUploadId = 'stale-upload';
    const activeUploadId = 'active-upload';
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await fs.writeFile(path.join(tusDir, staleUploadId), 'partial');
    await fs.writeFile(
      path.join(tusDir, `${staleUploadId}.json`),
      JSON.stringify({
        id: staleUploadId,
        size: 1024,
        metadata: { filename: 'stale.bin' },
        creation_date: staleDate.toISOString(),
      })
    );
    await fs.utimes(path.join(tusDir, staleUploadId), staleDate, staleDate);
    await fs.utimes(path.join(tusDir, `${staleUploadId}.json`), staleDate, staleDate);

    await fs.writeFile(path.join(tusDir, activeUploadId), 'partial');
    await fs.writeFile(
      path.join(tusDir, `${activeUploadId}.json`),
      JSON.stringify({
        id: activeUploadId,
        size: 1024,
        metadata: { filename: 'active.bin' },
        creation_date: new Date().toISOString(),
      })
    );

    const { cleanupExpiredUploads } = envContext.requireFresh('src/services/tusUploadService');
    await cleanupExpiredUploads({ force: true });

    await expect(fs.access(path.join(tusDir, staleUploadId))).rejects.toBeTruthy();
    await expect(fs.access(path.join(tusDir, `${staleUploadId}.json`))).rejects.toBeTruthy();
    await expect(fs.access(path.join(tusDir, activeUploadId))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tusDir, `${activeUploadId}.json`))).resolves.toBeUndefined();
  });

  /**
   * Uppy stringifies every field named in `allowedMetaFields`, whether or not
   * the file carries it — a field the file doesn't have arrives as the literal
   * string "undefined". Only folder uploads get `resolvedRelativePath`, so a
   * plain file sends "undefined" and used to be stored under that name.
   */
  it('ignores metadata Uppy stringified from a missing value', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const content = Buffer.from('dropped straight onto the file list');

    try {
      const create = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(content.length))
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'report.txt',
            relativePath: 'report.txt',
            resolvedRelativePath: 'undefined',
            uploadTo: 'Nvm',
          })
        );

      expect(create.status).toBe(201);

      const uploadPath = new URL(create.headers.location).pathname;
      const patch = await request(baseUrl)
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(content);

      expect(patch.status).toBe(204);
      await expect(
        fs.readFile(path.join(envContext.volumeDir, 'Nvm', 'report.txt'), 'utf8')
      ).resolves.toBe('dropped straight onto the file list');
      await expect(
        fs.access(path.join(envContext.volumeDir, 'Nvm', 'undefined'))
      ).rejects.toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });

  /**
   * A zero-byte file finishes inside its own creation request: the server sees
   * offset === size and calls onUploadFinish from the POST handler. It then
   * reads the upload back to compute Upload-Expires, so anything the hook
   * removes has to still be there — otherwise creation answers 404 and the
   * whole folder the file belonged to fails.
   */
  it('accepts an empty file, which completes during creation', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);

    try {
      const create = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '0')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'empty.js',
            relativePath: 'empty.js',
            uploadTo: 'Nvm',
          })
        );

      expect(create.status).toBe(201);
      await expect(
        fs.readFile(path.join(envContext.volumeDir, 'Nvm', 'empty.js'), 'utf8')
      ).resolves.toBe('');
    } finally {
      await closeServer(server);
    }
  });

  /**
   * When the cache and the destination sit on different filesystems — the norm
   * once a user has more than one volume mounted — the finished file is copied
   * rather than renamed. The client has stopped sending by then, so without
   * this its progress bar sits at 100% for the length of the copy.
   *
   * The copy is observed from inside `unlink`, which the service calls once the
   * bytes are written and before it forgets the upload. That is the last moment
   * the entry is still there, and it makes the assertion deterministic instead
   * of a race against a copy that finishes in milliseconds.
   */
  it('reports the final copy while it is still running', async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });

    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });

    const content = Buffer.alloc(256 * 1024, 'x');
    let seen = null;

    const originalRename = fs.rename;
    const originalUnlink = fs.unlink;
    fs.rename = async () => {
      const error = new Error('EXDEV: cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    };

    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);

    fs.unlink = async (...args) => {
      if (!seen) {
        const response = await request(baseUrl).get('/api/upload/finalizations');
        seen = response.body;
      }
      return originalUnlink(...args);
    };

    try {
      const create = await request(baseUrl)
        .post('/api/upload/tus')
        .set('Cookie', cookie)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(content.length))
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'large.bin',
            relativePath: 'large.bin',
            uploadTo: 'Nvm',
          })
        );

      expect(create.status).toBe(201);

      const uploadPath = new URL(create.headers.location).pathname;
      const patch = await request(baseUrl)
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(content);

      expect(patch.status).toBe(204);

      // The copy was visible, counted, and named after the file being written.
      expect(seen?.items).toEqual([
        { name: 'large.bin', copiedBytes: content.length, totalBytes: content.length },
      ]);

      // Copied, not just reported: the file is whole at its destination.
      const stored = await fs.stat(path.join(envContext.volumeDir, 'Nvm', 'large.bin'));
      expect(stored.size).toBe(content.length);

      // And forgotten once it is done, so nothing lingers in the list.
      const after = await request(baseUrl).get('/api/upload/finalizations');
      expect(after.body).toEqual({ items: [] });
    } finally {
      fs.rename = originalRename;
      fs.unlink = originalUnlink;
      await closeServer(server);
    }
  });
});
