import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { Writable } from 'node:stream';
import request from 'supertest';
import { setupTestEnv, modulePath } from '../helpers/env-test-utils.js';

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

const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

const codedError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

const createUpload = async (baseUrl, cookie, name, length) => {
  const create = await request(baseUrl)
    .post('/api/upload/tus')
    .set('Cookie', cookie)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', String(length))
    .set(
      'Upload-Metadata',
      encodeMetadata({ filename: name, relativePath: name, uploadTo: 'Nvm' })
    );
  expect(create.status).toBe(201);
  return new URL(create.headers.location).pathname;
};

/** The whole file in one PATCH. Returns the supertest request, not yet sent. */
const sendUpload = (baseUrl, uploadPath, content) =>
  request(baseUrl)
    .patch(uploadPath)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', '0')
    .set('Content-Type', 'application/offset+octet-stream')
    .send(content);

/** Age both files of an upload in the cache past the default one-hour TTL. */
const ageUpload = async (tusDir, uploadId) => {
  const aged = TWO_HOURS_AGO();
  await fs.utimes(path.join(tusDir, uploadId), aged, aged);
  await fs.utimes(path.join(tusDir, `${uploadId}.json`), aged, aged);
};

const expectUploadInCache = async (tusDir, uploadId, size) => {
  expect((await fs.stat(path.join(tusDir, uploadId))).size).toBe(size);
  await expect(fs.access(path.join(tusDir, `${uploadId}.json`))).resolves.toBeUndefined();
};

const expectUploadGone = async (tusDir, uploadId) => {
  await expect(fs.access(path.join(tusDir, uploadId))).rejects.toBeTruthy();
  await expect(fs.access(path.join(tusDir, `${uploadId}.json`))).rejects.toBeTruthy();
};

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

    // Only a move out of the cache crosses devices: the partial copy is written
    // beside its destination and renamed within that filesystem.
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const originalRename = fs.rename;
    const originalUnlink = fs.unlink;
    fs.rename = async (source, destination) => {
      if (String(source).startsWith(tusDir + path.sep)) {
        throw codedError('EXDEV', 'cross-device link not permitted');
      }
      return originalRename(source, destination);
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
      // With nothing left beside it from the copy.
      expect(await fs.readdir(path.join(envContext.volumeDir, 'Nvm'))).toEqual(['large.bin']);

      // And forgotten once it is done, so nothing lingers in the list.
      const after = await request(baseUrl).get('/api/upload/finalizations');
      expect(after.body).toEqual({ items: [] });
    } finally {
      fs.rename = originalRename;
      fs.unlink = originalUnlink;
      await closeServer(server);
    }
  });

  const enableChunkedUploads = async () => {
    const settingsService = envContext.requireFresh('src/services/settingsService');
    await settingsService.setSystemSetting('system', 'uploads', {
      chunkedEnabled: true,
      chunkSizeBytes: 1024 * 1024,
    });
    await fs.mkdir(path.join(envContext.volumeDir, 'Nvm'), { recursive: true });
  };

  /**
   * The upload's last byte arrived, and moving the file into its folder failed.
   * The data and its metadata stay in the cache — complete, so the sweep used to
   * pass over them every time, and nothing else ever removed them.
   */
  it('sweeps a finished upload that was never moved into place once past the TTL, not before', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const content = Buffer.from('sent in full, never arrived');

    const originalRename = fs.rename;
    fs.rename = async (source, destination) => {
      if (String(source).startsWith(tusDir + path.sep)) {
        throw codedError('EACCES', 'permission denied');
      }
      return originalRename(source, destination);
    };

    try {
      const oldPath = await createUpload(baseUrl, cookie, 'old.txt', content.length);
      const recentPath = await createUpload(baseUrl, cookie, 'recent.txt', content.length);
      expect((await sendUpload(baseUrl, oldPath, content)).status).toBe(500);
      expect((await sendUpload(baseUrl, recentPath, content)).status).toBe(500);
      fs.rename = originalRename;

      const oldId = path.basename(oldPath);
      const recentId = path.basename(recentPath);
      await expectUploadInCache(tusDir, oldId, content.length);
      await expectUploadInCache(tusDir, recentId, content.length);
      expect(await fs.readdir(path.join(envContext.volumeDir, 'Nvm'))).toEqual([]);

      await ageUpload(tusDir, oldId);
      const tus = require(modulePath('src/services/tusUploadService'));
      await tus.cleanupExpiredUploads({ force: true });

      await expectUploadGone(tusDir, oldId);
      await expectUploadInCache(tusDir, recentId, content.length);
    } finally {
      fs.rename = originalRename;
      await closeServer(server);
    }
  });

  /**
   * Age does not tell a stuck upload from one moving into place: a copy to
   * another filesystem can outlast the TTL, and an empty PATCH at the final
   * offset finishes an old upload again. The move is held here while the
   * upload is older than the TTL, and the sweep runs in between.
   */
  it('leaves an old upload alone while it is being moved into place', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const content = Buffer.from('moved while the sweep ran');

    let markMoveReached;
    const moveReached = new Promise((resolve) => {
      markMoveReached = resolve;
    });
    let releaseMove;
    const moveReleased = new Promise((resolve) => {
      releaseMove = resolve;
    });

    const originalRename = fs.rename;
    fs.rename = async (source, destination) => {
      if (String(source).startsWith(tusDir + path.sep)) {
        markMoveReached();
        await moveReleased;
        throw codedError('EXDEV', 'cross-device link not permitted');
      }
      return originalRename(source, destination);
    };

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'late.txt', content.length);
      const uploadId = path.basename(uploadPath);
      const pending = sendUpload(baseUrl, uploadPath, content).then((response) => response);

      await moveReached;
      await ageUpload(tusDir, uploadId);
      const tus = require(modulePath('src/services/tusUploadService'));
      await tus.cleanupExpiredUploads({ force: true });
      await expectUploadInCache(tusDir, uploadId, content.length);

      releaseMove();
      expect((await pending).status).toBe(204);
      await expect(
        fs.readFile(path.join(envContext.volumeDir, 'Nvm', 'late.txt'), 'utf8')
      ).resolves.toBe('moved while the sweep ran');
    } finally {
      releaseMove();
      fs.rename = originalRename;
      await closeServer(server);
    }
  });

  /**
   * Across filesystems the file is written again, and a copy stopped halfway —
   * a full disk here, a killed process in production — used to leave a
   * truncated file under the name the user asked for. The folder is read while
   * part of the file is on disk, then the copy fails.
   */
  it('never shows a partial copy under the final name, and removes it when the copy fails', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.alloc(256 * 1024, 'x');

    const originalRename = fs.rename;
    const originalCreateWriteStream = fsSync.createWriteStream;
    fs.rename = async (source, destination) => {
      if (String(source).startsWith(tusDir + path.sep)) {
        throw codedError('EXDEV', 'cross-device link not permitted');
      }
      return originalRename(source, destination);
    };

    let partialBytes = 0;
    let folderDuringCopy = null;
    fsSync.createWriteStream = (target, options) => {
      const real = originalCreateWriteStream(target, options);
      if (!String(target).startsWith(nvmDir + path.sep)) return real;
      let chunks = 0;
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks += 1;
          if (chunks === 1) {
            real.write(chunk, callback);
            return;
          }
          real.end(() => {
            partialBytes = fsSync.statSync(target).size;
            folderDuringCopy = fsSync.readdirSync(nvmDir);
            callback(codedError('ENOSPC', 'no space left on device'));
          });
        },
        final(callback) {
          real.end(callback);
        },
      });
    };

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'large.bin', content.length);
      expect((await sendUpload(baseUrl, uploadPath, content)).status).toBe(500);

      // A partial file really was on disk when the folder was read.
      expect(partialBytes).toBeGreaterThan(0);
      expect(partialBytes).toBeLessThan(content.length);
      expect(folderDuringCopy).not.toContain('large.bin');

      // Nothing left in the folder, and the upload still whole in the cache.
      expect(await fs.readdir(nvmDir)).toEqual([]);
      await expectUploadInCache(tusDir, path.basename(uploadPath), content.length);
    } finally {
      fs.rename = originalRename;
      fsSync.createWriteStream = originalCreateWriteStream;
      await closeServer(server);
    }
  });

  /**
   * The name is chosen before the copy starts. A file written under it used to
   * hold it for the copy's whole length; a hidden partial copy does not, so
   * whatever lands there meanwhile must not be overwritten by the rename. The
   * move is held after the name is chosen, and a file arrives under it.
   */
  it('does not overwrite a file that arrives under the same name during the copy', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('the upload');

    let markMoveReached;
    const moveReached = new Promise((resolve) => {
      markMoveReached = resolve;
    });
    let releaseMove;
    const moveReleased = new Promise((resolve) => {
      releaseMove = resolve;
    });

    const originalRename = fs.rename;
    fs.rename = async (source, destination) => {
      if (String(source).startsWith(tusDir + path.sep)) {
        markMoveReached();
        await moveReleased;
        throw codedError('EXDEV', 'cross-device link not permitted');
      }
      return originalRename(source, destination);
    };

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'large.bin', content.length);
      const pending = sendUpload(baseUrl, uploadPath, content).then((response) => response);

      await moveReached;
      await fs.writeFile(path.join(nvmDir, 'large.bin'), 'arrived meanwhile');
      releaseMove();
      expect((await pending).status).toBe(204);

      expect((await fs.readdir(nvmDir)).sort()).toEqual(['large (1).bin', 'large.bin']);
      await expect(fs.readFile(path.join(nvmDir, 'large.bin'), 'utf8')).resolves.toBe(
        'arrived meanwhile'
      );
      await expect(fs.readFile(path.join(nvmDir, 'large (1).bin'), 'utf8')).resolves.toBe(
        'the upload'
      );
    } finally {
      releaseMove();
      fs.rename = originalRename;
      await closeServer(server);
    }
  });

  /**
   * A process killed during the copy leaves its hidden partial file beside the
   * destination. The direct upload path sweeps such remains where it is about
   * to write; a chunked upload to the same folder does too.
   */
  it('removes what a killed copy left in the destination when the next upload is created', async () => {
    await enableChunkedUploads();
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const remnant = path.join(nvmDir, '.upload-0123456789abcdef.uploading');
    await fs.writeFile(remnant, 'half a file');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(remnant, twoDaysAgo, twoDaysAgo);

    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);

    try {
      await createUpload(baseUrl, cookie, 'next.txt', 5);
      await expect(fs.access(remnant)).rejects.toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });
});

describe('TUS upload cache sweep timer', () => {
  let envContext;

  beforeEach(async () => {
    envContext = await setupTestEnv({
      tag: 'tus-sweep-timer-test-',
      env: { TUS_CLEANUP_INTERVAL_MS: '40' },
    });
  });

  afterEach(async () => {
    await envContext.cleanup();
  });

  const writeAbandonedUpload = async (tusDir, uploadId) => {
    await fs.writeFile(path.join(tusDir, uploadId), 'partial');
    await fs.writeFile(
      path.join(tusDir, `${uploadId}.json`),
      JSON.stringify({ id: uploadId, size: 1024, metadata: { filename: `${uploadId}.bin` } })
    );
    await ageUpload(tusDir, uploadId);
  };

  const waitUntilGone = async (filePath, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fs.access(filePath);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  /**
   * Sweeping used to happen at load and when an upload was created, so a
   * server nobody uploaded to kept whatever its cache held. Nothing here
   * creates an upload: only the timer can remove the second file, written
   * after the sweep that removed the first had already read the directory.
   */
  it('sweeps the cache on a timer until stopped', async () => {
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    await fs.mkdir(tusDir, { recursive: true });
    const tus = envContext.requireFresh('src/services/tusUploadService');

    await writeAbandonedUpload(tusDir, 'before-start');
    tus.startCacheSweep();
    try {
      expect(await waitUntilGone(path.join(tusDir, 'before-start'))).toBe(true);
      await writeAbandonedUpload(tusDir, 'while-running');
      expect(await waitUntilGone(path.join(tusDir, 'while-running'))).toBe(true);
    } finally {
      await tus.stopCacheSweep();
    }

    await writeAbandonedUpload(tusDir, 'after-stop');
    // Ten intervals.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(fs.access(path.join(tusDir, 'after-stop'))).resolves.toBeUndefined();
  });
});
