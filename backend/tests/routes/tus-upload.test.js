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

/**
 * Moves out of the upload cache, intercepted. A finished upload is moved by a
 * hard link, or by a rename where the filesystem has none, so both are
 * patched. `before` runs first — to hold the move, or to put something under
 * the name at the last moment — and `code`, when given, then fails the move as
 * a cache on another filesystem (EXDEV) or a folder the server may not write
 * (EACCES) does. Answers the function that puts both back.
 */
const interceptCacheMoves = (tusDir, { code = null, before = null } = {}) => {
  const originalLink = fs.link;
  const originalRename = fs.rename;
  const intercept = (original) => async (source, destination) => {
    if (String(source).startsWith(tusDir + path.sep)) {
      if (before) await before(source, destination);
      if (code) throw codedError(code, 'intercepted move out of the upload cache');
    }
    return original(source, destination);
  };
  fs.link = intercept(originalLink);
  fs.rename = intercept(originalRename);
  return () => {
    fs.link = originalLink;
    fs.rename = originalRename;
  };
};

/** Ask for an upload's offset, as a client resuming it does. */
const head = (baseUrl, uploadPath, user) => {
  const req = request(baseUrl).head(uploadPath).set('Tus-Resumable', '1.0.0');
  return user ? req.set('X-Test-User', user) : req;
};

const finalizeError = (response) => {
  const raw = response.headers['upload-finalize-error'];
  return raw === undefined ? undefined : decodeURIComponent(raw);
};

const NOT_ALLOWED =
  'The file was received, but it could not be put in its folder: the server is not allowed to write there.';

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
    const requestLog = [];
    app.use((req, _res, next) => {
      if (req.path.startsWith('/api/upload/tus')) requestLog.push(req.method);
      // Someone other than the person uploading, when a test names one.
      const other = req.headers['x-test-user'];
      req.user = other
        ? { id: other, email: `${other}@example.com`, roles: ['user'] }
        : { id: 'admin', email: 'admin@example.com', roles: ['admin'] };
      next();
    });
    app.use('/api', uploadRoutes);
    app.use(errorHandler);
    const server = http.createServer(app);
    // What reached the chunked upload route, by method, in order.
    server.requestLog = requestLog;
    return server;
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
    // beside its destination and linked under its name within that filesystem.
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const originalUnlink = fs.unlink;
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EXDEV' });

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
      restoreMoves();
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

    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EACCES' });

    try {
      const oldPath = await createUpload(baseUrl, cookie, 'old.txt', content.length);
      const recentPath = await createUpload(baseUrl, cookie, 'recent.txt', content.length);
      expect((await sendUpload(baseUrl, oldPath, content)).status).toBe(500);
      expect((await sendUpload(baseUrl, recentPath, content)).status).toBe(500);
      restoreMoves();

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
      restoreMoves();
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

    const restoreMoves = interceptCacheMoves(tusDir, {
      code: 'EXDEV',
      before: async () => {
        markMoveReached();
        await moveReleased;
      },
    });

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
      restoreMoves();
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

    const originalCreateWriteStream = fsSync.createWriteStream;
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EXDEV' });

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
      const response = await sendUpload(baseUrl, uploadPath, content);
      // A full volume, said as such: 507 and the reason, not a generic 500.
      expect(response.status).toBe(507);
      expect(finalizeError(response)).toBe(
        'The file was received, but it could not be put in its folder: there is not enough space left on the volume.'
      );

      // A partial file really was on disk when the folder was read.
      expect(partialBytes).toBeGreaterThan(0);
      expect(partialBytes).toBeLessThan(content.length);
      expect(folderDuringCopy).not.toContain('large.bin');

      // Nothing left in the folder, and the upload still whole in the cache.
      expect(await fs.readdir(nvmDir)).toEqual([]);
      await expectUploadInCache(tusDir, path.basename(uploadPath), content.length);
    } finally {
      restoreMoves();
      fsSync.createWriteStream = originalCreateWriteStream;
      await closeServer(server);
    }
  });

  /**
   * A file written under its own name used to hold that name for the copy's
   * whole length; a hidden partial copy does not, so whatever lands there
   * meanwhile must not be overwritten when the copy takes the name. The move is
   * held before the copy, and a file arrives under the name.
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

    const restoreMoves = interceptCacheMoves(tusDir, {
      code: 'EXDEV',
      before: async () => {
        markMoveReached();
        await moveReleased;
      },
    });

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
      restoreMoves();
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

  /**
   * On one filesystem the finished file is linked into its folder. The name is
   * free when the move begins; a file put under it at the last moment, just
   * before the move, is kept, and the upload takes the next name.
   */
  it('does not overwrite a file that arrives under the name as the upload is moved in', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('the upload');

    let arrived = false;
    const restoreMoves = interceptCacheMoves(tusDir, {
      before: async (_source, destination) => {
        if (arrived) return;
        arrived = true;
        await fs.writeFile(destination, 'arrived meanwhile');
      },
    });

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      expect((await sendUpload(baseUrl, uploadPath, content)).status).toBe(204);

      expect(arrived).toBe(true);
      expect((await fs.readdir(nvmDir)).sort()).toEqual(['notes (1).txt', 'notes.txt']);
      await expect(fs.readFile(path.join(nvmDir, 'notes.txt'), 'utf8')).resolves.toBe(
        'arrived meanwhile'
      );
      await expect(fs.readFile(path.join(nvmDir, 'notes (1).txt'), 'utf8')).resolves.toBe(
        'the upload'
      );
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * Every byte arrived and the file could not be moved into its folder. Thrown,
   * that was a 500 with a generic body, which the client retried into a false
   * success (see the HEAD tests below). It is answered with the reason, in the
   * body and in a header a cross-origin client is allowed to read, and without
   * the server's own paths.
   */
  it('answers a move into the folder that fails with the reason, in a header the client can read', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const content = Buffer.from('sent in full');
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EACCES' });

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      const response = await sendUpload(baseUrl, uploadPath, content);

      expect(response.status).toBe(500);
      expect(finalizeError(response)).toBe(NOT_ALLOWED);
      expect(response.text.trim()).toBe(NOT_ALLOWED);
      expect(response.text).not.toContain(envContext.tmpRoot);
      expect(response.headers['access-control-expose-headers']).toMatch(
        /\bUpload-Finalize-Error\b/
      );
      await expectUploadInCache(tusDir, path.basename(uploadPath), content.length);
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * The client retries a failed PATCH by asking for the offset. @tus/server
   * answered from the cache, where the upload is complete, and tus-js-client
   * then reported the upload as done without another request: a file that
   * never reached its folder, shown as uploaded. The move is tried again
   * instead, and the offset is complete only once the file is in its folder.
   */
  it('tries the move again when asked for the offset, and says complete only once the file is in place', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('placed on the second try');
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EACCES' });

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      const uploadId = path.basename(uploadPath);
      expect((await sendUpload(baseUrl, uploadPath, content)).status).toBe(500);

      // Still failing: an error with the reason. Never complete, and never the
      // other refusals, which the client takes as an upload to create again.
      const failing = await head(baseUrl, uploadPath);
      expect(failing.status).toBe(423);
      expect(finalizeError(failing)).toBe(NOT_ALLOWED);
      expect(failing.headers['upload-offset']).toBeUndefined();
      expect(await fs.readdir(nvmDir)).toEqual([]);
      await expectUploadInCache(tusDir, uploadId, content.length);

      restoreMoves();
      const placed = await head(baseUrl, uploadPath);
      expect(placed.status).toBe(200);
      expect(placed.headers['upload-offset']).toBe(String(content.length));
      expect(placed.headers['upload-length']).toBe(String(content.length));
      expect(placed.headers['cache-control']).toBe('no-store');
      expect(finalizeError(placed)).toBeUndefined();
      await expect(fs.readFile(path.join(nvmDir, 'notes.txt'), 'utf8')).resolves.toBe(
        'placed on the second try'
      );
      await expectUploadGone(tusDir, uploadId);

      // Asked again: still complete, and placed once.
      expect((await head(baseUrl, uploadPath)).status).toBe(200);
      expect(await fs.readdir(nvmDir)).toEqual(['notes.txt']);
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * Once placed, the upload leaves the cache, and @tus/server answers a HEAD for
   * it with 404, which tus-js-client takes as an upload to start over: a PATCH
   * whose response was lost during a long copy was retried that way, and the
   * whole file sent again and stored twice. Said only to the person who sent it.
   */
  it('says an upload placed a moment ago is complete, to the person who sent it', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const content = Buffer.from('already in its folder');

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      expect((await sendUpload(baseUrl, uploadPath, content)).status).toBe(204);

      const response = await head(baseUrl, uploadPath);
      expect(response.status).toBe(200);
      expect(response.headers['upload-offset']).toBe(String(content.length));
      expect(response.headers['upload-length']).toBe(String(content.length));
      expect(response.headers['tus-resumable']).toBe('1.0.0');
      expect(response.headers['cache-control']).toBe('no-store');

      expect((await head(baseUrl, uploadPath, 'someone-else')).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  /**
   * Asked for the offset while the file is being moved in, by a client whose
   * PATCH response was lost during a long copy, the answer waits for that move
   * rather than reading the cache, and the file is placed once.
   */
  it('waits for a move in progress before saying the upload is complete', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('moved while someone asked');

    let markMoveReached;
    const moveReached = new Promise((resolve) => {
      markMoveReached = resolve;
    });
    let releaseMove;
    const moveReleased = new Promise((resolve) => {
      releaseMove = resolve;
    });
    const restoreMoves = interceptCacheMoves(tusDir, {
      before: async () => {
        markMoveReached();
        await moveReleased;
      },
    });

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'late.txt', content.length);
      const pending = sendUpload(baseUrl, uploadPath, content).then((response) => response);
      await moveReached;

      let placedWhenAnswered = null;
      const asked = head(baseUrl, uploadPath).then((response) => {
        placedWhenAnswered = fsSync.existsSync(path.join(nvmDir, 'late.txt'));
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(placedWhenAnswered).toBeNull();

      releaseMove();
      expect((await pending).status).toBe(204);
      const answer = await asked;
      expect(answer.status).toBe(200);
      expect(answer.headers['upload-offset']).toBe(String(content.length));
      expect(placedWhenAnswered).toBe(true);
      expect(await fs.readdir(nvmDir)).toEqual(['late.txt']);
    } finally {
      releaseMove();
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * The move tried again on a HEAD is authorised with that request's user, as
   * the PATCH was: someone who may not upload to the folder cannot finish an
   * upload into it.
   */
  it('does not move a stuck upload into place for someone who may not upload there', async () => {
    await enableChunkedUploads();
    await envContext
      .requireFresh('src/services/accessControlService')
      .setRules([{ path: 'Nvm', recursive: true, permissions: 'ro' }]);
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('an administrator sent this');
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EACCES' });

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      const uploadId = path.basename(uploadPath);
      expect((await sendUpload(baseUrl, uploadPath, content)).status).toBe(500);
      restoreMoves();

      const refused = await head(baseUrl, uploadPath, 'reader');
      expect(refused.status).toBe(403);
      expect(await fs.readdir(nvmDir)).toEqual([]);
      await expectUploadInCache(tusDir, uploadId, content.length);

      // The administrator who sent it still can.
      expect((await head(baseUrl, uploadPath)).status).toBe(200);
      expect(await fs.readdir(nvmDir)).toEqual(['notes.txt']);
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * Send `content` with tus-js-client, the library behind the browser's
   * uploads, and answer how it ended. Its own decision on what to retry, with
   * no wait in between.
   */
  const uploadWithClient = (baseUrl, name, content) =>
    new Promise((resolve) => {
      const { Upload } = require('tus-js-client');
      const upload = new Upload(content, {
        endpoint: `${baseUrl}/api/upload/tus`,
        metadata: { filename: name, relativePath: name, uploadTo: 'Nvm' },
        retryDelays: [0, 0, 0],
        onSuccess: () => resolve({ succeeded: true }),
        onError: (error) => resolve({ succeeded: false, error }),
      });
      upload.start();
    });

  /**
   * What the person finally sees is the client's reading of the exchange, so
   * the exchange is played with the client itself. A move that keeps failing
   * used to end in a success: the retry's HEAD was answered complete from the
   * cache. It ends in an error carrying the reason, and the file is not created
   * and sent a second time, which tus-js-client does for any refusal of that
   * HEAD other than 423.
   */
  it('ends, for tus-js-client, in an error with the reason when the move keeps failing', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EACCES' });

    try {
      const outcome = await uploadWithClient(baseUrl, 'notes.txt', Buffer.from('never placed'));

      expect(outcome.succeeded).toBe(false);
      const header = outcome.error?.originalResponse?.getHeader('Upload-Finalize-Error');
      expect(decodeURIComponent(header)).toBe(NOT_ALLOWED);
      expect(server.requestLog.filter((method) => method === 'POST')).toHaveLength(1);
      expect(await fs.readdir(nvmDir)).toEqual([]);
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  it('ends, for tus-js-client, in a success only once a retried move put the file in its folder', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    let failures = 0;
    const restoreMoves = interceptCacheMoves(tusDir, {
      before: async () => {
        if (failures > 0) return;
        failures += 1;
        throw codedError('EACCES', 'permission denied');
      },
    });

    try {
      const outcome = await uploadWithClient(
        baseUrl,
        'notes.txt',
        Buffer.from('placed on the retry')
      );

      expect(outcome.error).toBeUndefined();
      expect(outcome.succeeded).toBe(true);
      expect(failures).toBe(1);
      await expect(fs.readFile(path.join(nvmDir, 'notes.txt'), 'utf8')).resolves.toBe(
        'placed on the retry'
      );
      expect(await fs.readdir(nvmDir)).toEqual(['notes.txt']);
      expect(server.requestLog.filter((method) => method === 'POST')).toHaveLength(1);
    } finally {
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * Across filesystems the cache copy is removed once the file is in its
   * folder. A failure to remove it used to fail the upload, though the file
   * had arrived, and a retry would then have placed it a second time. What
   * stays in the cache is the sweep's to remove.
   */
  it('reports a copied upload as arrived even when its cache copy cannot be removed', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const tusDir = path.join(envContext.cacheDir, 'tus-uploads');
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');
    const content = Buffer.from('copied, then stuck in the cache');
    const restoreMoves = interceptCacheMoves(tusDir, { code: 'EXDEV' });
    const originalUnlink = fs.unlink;
    let refusedRemoval = false;
    fs.unlink = async (target) => {
      const inCache = String(target).startsWith(tusDir + path.sep);
      if (inCache && !String(target).endsWith('.json')) {
        refusedRemoval = true;
        throw codedError('EBUSY', 'resource busy or locked');
      }
      return originalUnlink(target);
    };

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'notes.txt', content.length);
      const response = await sendUpload(baseUrl, uploadPath, content);

      expect(refusedRemoval).toBe(true);
      expect(response.status).toBe(204);
      expect(finalizeError(response)).toBeUndefined();
      await expect(fs.readFile(path.join(nvmDir, 'notes.txt'), 'utf8')).resolves.toBe(
        'copied, then stuck in the cache'
      );

      // Asked again, it is complete, and still in its folder once.
      expect((await head(baseUrl, uploadPath)).status).toBe(200);
      expect(await fs.readdir(nvmDir)).toEqual(['notes.txt']);
    } finally {
      fs.unlink = originalUnlink;
      restoreMoves();
      await closeServer(server);
    }
  });

  /**
   * Only an upload whose every byte arrived is answered here. One still being
   * sent is answered as before, with its real offset, and nothing is moved
   * into the folder before its last byte.
   */
  it('answers an unfinished upload with its offset and moves nothing', async () => {
    await enableChunkedUploads();
    const server = buildApp();
    const baseUrl = await startServer(server);
    const cookie = await establishSession(baseUrl);
    const nvmDir = path.join(envContext.volumeDir, 'Nvm');

    try {
      const uploadPath = await createUpload(baseUrl, cookie, 'half.txt', 20);
      const first = await sendUpload(baseUrl, uploadPath, Buffer.from('0123456789'));
      expect(first.status).toBe(204);

      const response = await head(baseUrl, uploadPath);
      expect(response.status).toBe(200);
      expect(response.headers['upload-offset']).toBe('10');
      expect(response.headers['upload-length']).toBe('20');
      expect(await fs.readdir(nvmDir)).toEqual([]);
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
