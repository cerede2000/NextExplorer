const crypto = require('node:crypto');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('node:fs');
const { pipeline } = require('node:stream/promises');

const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');

const { upload: uploadConfig } = require('../config');
const { ensureDir, pathExists } = require('../utils/fsUtils');
const { normalizeRelativePath, findAvailableName } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { resolveFolderUploadRelativePath } = require('./uploadFolderTargetService');
const { ensureStorageAvailable } = require('./uploadStorageGuard');
const { sweepStaleUploadRemnants, UPLOADING_SUFFIX } = require('./uploadRemnants');
const { getSystemSettings } = require('./settingsService');
const { InsufficientStorageError } = require('../errors/AppError');
const logger = require('../utils/logger');

const TUS_PATH = '/api/upload/tus';
const TUS_CACHE_DIR = uploadConfig?.tusUploadDir;
const TUS_INCOMPLETE_UPLOAD_TTL_MS = uploadConfig?.tusIncompleteUploadTtlMs ?? 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = uploadConfig?.tusCleanupIntervalMs ?? 10 * 60 * 1000;

let lastCleanupAt = 0;

// Deliberately without `expirationPeriodInMilliseconds`. Declaring it turns on
// the protocol's expiration extension, and @tus/server then re-reads an upload
// straight after finishing it to work out Upload-Expires — a header it only
// sends for *unfinished* uploads, so the read is pointless yet fatal: an empty
// file completes inside its own creation request, and the read fails on the
// data this hook has just moved to its destination. Expiry is handled by
// cleanupInactiveUploads below, which covers more ground anyway (it also
// reclaims data files whose metadata never made it to disk).
const fileStore = new FileStore({
  directory: TUS_CACHE_DIR,
});

/**
 * A metadata value, or '' when the client did not really send one.
 *
 * Uppy stringifies every field named in `allowedMetaFields`, whether the file
 * carries it or not, so a field only folder uploads populate arrives as the
 * literal string "undefined" on every other upload. Taken at face value it
 * became the name the file was stored under.
 */
const metadataValue = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === 'undefined' || trimmed === 'null' ? '' : trimmed;
};

const tusError = (statusCode, message) => ({
  status_code: statusCode,
  body: `${message}\n`,
});

/**
 * The shared guard, wearing the shape @tus/server answers with. Its own errors
 * are thrown, not returned, so an AppError would leave here as a 500 and the
 * client would retry a request that can only fail again — 507 is what tells it
 * to stop.
 */
const ensureTusStorageAvailable = async (directory, uploadSize, label) => {
  try {
    await ensureStorageAvailable(directory, uploadSize, label);
  } catch (err) {
    if (err instanceof InsufficientStorageError) {
      throw tusError(507, err.message);
    }
    throw err;
  }
};

const getNodeRequest = (req) => req?.runtime?.node?.req || req?.node?.req || null;

const getContext = (req) => {
  const nodeReq = getNodeRequest(req);
  return {
    nodeReq,
  };
};

// Cache the "is TUS allowed" check briefly so it isn't a fresh DB read on every
// chunk (each PATCH hits onIncomingRequest) — trims per-chunk latency.
let tusEnabledCache = { enabled: null, at: 0 };
const TUS_ENABLED_TTL_MS = 5000;

const ensureTusEnabled = async () => {
  const now = Date.now();
  if (tusEnabledCache.enabled === null || now - tusEnabledCache.at >= TUS_ENABLED_TTL_MS) {
    const settings = await getSystemSettings();
    // TUS serves both forced chunked uploads AND the client-side auto-fallback,
    // which uses TUS even though forced chunking (chunkedEnabled) is off. Without
    // allowing chunkedAutoFallback here, fallback uploads were rejected with 403
    // (surfacing as a "network error" in the client).
    tusEnabledCache = {
      enabled: Boolean(settings.uploads?.chunkedEnabled || settings.uploads?.chunkedAutoFallback),
      at: now,
    };
  }
  if (!tusEnabledCache.enabled) {
    throw tusError(403, 'Chunked uploads are disabled.');
  }
};

const safeStat = async (filePath) => {
  try {
    return await fs.stat(filePath);
  } catch (_) {
    return null;
  }
};

const safeReadJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
};

const rmIfExists = async (filePath) => {
  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to remove stale TUS cache file');
    return false;
  }
};

const getLastActivityMs = (...stats) =>
  Math.max(
    0,
    ...stats.filter(Boolean).map((statsItem) => Number(statsItem.mtimeMs || statsItem.ctimeMs || 0))
  );

/**
 * Uploads whose onUploadFinish is running, whatever their age.
 *
 * Age alone does not protect them. The last write refreshes the data file just
 * before the hook starts, but a copy to another filesystem can outlast the TTL
 * without touching the source again, and @tus/server calls the hook again for
 * an empty PATCH at the final offset — so a finished upload that has sat in the
 * cache for a day can be moving into place right now. The sweep asks this set
 * immediately before each removal, with nothing awaited in between.
 */
const finishing = new Set();

const cleanupInactiveUploads = async (now = Date.now()) => {
  if (TUS_INCOMPLETE_UPLOAD_TTL_MS <= 0) return 0;

  await ensureDir(TUS_CACHE_DIR);

  let entries = [];
  try {
    entries = await fs.readdir(TUS_CACHE_DIR, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err }, 'Failed to inspect TUS upload cache');
    return 0;
  }

  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.json')) continue;

    const dataPath = path.join(TUS_CACHE_DIR, entry.name);
    if (fileNames.has(`${entry.name}.json`)) continue;

    const dataStats = await safeStat(dataPath);
    if (!dataStats || now - getLastActivityMs(dataStats) < TUS_INCOMPLETE_UPLOAD_TTL_MS) continue;
    if (finishing.has(entry.name)) continue;

    if (await rmIfExists(dataPath)) removedCount += 1;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const uploadId = entry.name.slice(0, -'.json'.length);
    const metadataPath = path.join(TUS_CACHE_DIR, entry.name);
    const dataPath = path.join(TUS_CACHE_DIR, uploadId);
    const [metadataStats, dataStats, metadata] = await Promise.all([
      safeStat(metadataPath),
      safeStat(dataPath),
      safeReadJson(metadataPath),
    ]);

    const lastActivityMs = getLastActivityMs(metadataStats, dataStats);
    if (now - lastActivityMs < TUS_INCOMPLETE_UPLOAD_TTL_MS) continue;
    if (finishing.has(uploadId)) continue;

    if (!dataStats) {
      if (await rmIfExists(metadataPath)) removedCount += 1;
      continue;
    }

    // A complete upload still here is one whose move into place failed: the
    // hook removes the data by moving it. Nothing else would ever take it
    // away, so it goes on the same TTL as an abandoned one — and says so, since
    // it is a file someone sent that never arrived.
    const expectedSize = Number(metadata?.size);
    const isComplete = Number.isFinite(expectedSize) && dataStats.size >= expectedSize;
    if (isComplete) {
      logger.warn(
        {
          uploadId,
          size: dataStats.size,
          destination: metadata?.metadata?.logicalRelativePath || metadata?.metadata?.filename,
        },
        'Removing a finished TUS upload that was never moved into place'
      );
    }

    const removed = await Promise.all([rmIfExists(dataPath), rmIfExists(metadataPath)]);
    removedCount += removed.filter(Boolean).length;
  }

  if (removedCount > 0) {
    logger.info({ removedCount }, 'Cleaned stale TUS upload cache files');
  }

  return removedCount;
};

let runningSweep = null;

const cleanupExpiredUploads = async ({ force = false } = {}) => {
  if (runningSweep) return runningSweep;

  const now = Date.now();
  if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  runningSweep = (async () => {
    try {
      await ensureDir(TUS_CACHE_DIR);
    } catch (err) {
      logger.warn({ err }, 'Failed to prepare TUS upload cache for cleanup');
      return;
    }

    try {
      await cleanupInactiveUploads(now);
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up inactive TUS uploads');
    }
  })().finally(() => {
    runningSweep = null;
  });

  return runningSweep;
};

let sweepTimer = null;
let sweepStarted = false;

/**
 * Sweep the upload cache now and every TUS_CLEANUP_INTERVAL_MS.
 *
 * Creating an upload sweeps too, but a server nobody uploads to never did
 * again after starting, so whatever a failed day left in the cache stayed
 * there until the next upload or the next restart. The timer is unref'd: it
 * must not keep a stopping process alive.
 */
const startCacheSweep = () => {
  if (sweepStarted) return;
  sweepStarted = true;

  cleanupExpiredUploads({ force: true }).catch((err) => {
    logger.warn({ err }, 'Failed to run initial TUS upload cleanup');
  });

  if (CLEANUP_INTERVAL_MS > 0) {
    sweepTimer = setInterval(() => {
      cleanupExpiredUploads({ force: true }).catch((err) => {
        logger.warn({ err }, 'Failed to run periodic TUS upload cleanup');
      });
    }, CLEANUP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
};

/**
 * Stop the timer and wait for a sweep in progress, so nothing is still reading
 * or recreating the cache directory once this resolves.
 */
const stopCacheSweep = async () => {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepStarted = false;
  if (runningSweep) await runningSweep.catch(() => {});
};

const resolveTusUploadTarget = async (nodeReq, metadata = {}) => {
  const filename =
    typeof metadata.filename === 'string' && metadata.filename.trim()
      ? metadata.filename.trim()
      : 'upload';
  const uploadTo = normalizeRelativePath(metadataValue(metadata.uploadTo));
  const resolvedRelativePath = metadataValue(metadata.resolvedRelativePath);
  const requestedRelativePath =
    normalizeRelativePath(
      resolvedRelativePath || metadataValue(metadata.relativePath) || filename
    ) || path.basename(filename);

  const context = { user: nodeReq?.user, guestSession: nodeReq?.guestSession };
  const { allowed, accessInfo, resolved } = await authorizeAndResolve(
    context,
    uploadTo,
    ACTIONS.upload
  );
  if (!allowed || !resolved) {
    throw tusError(403, accessInfo?.denialReason || 'Cannot upload files to this path.');
  }

  const { absolutePath: destinationRoot, relativePath: logicalBase } = resolved;
  const relativePath = resolvedRelativePath
    ? requestedRelativePath
    : await resolveFolderUploadRelativePath({
        relativePath: requestedRelativePath,
        destinationRoot,
        context,
        uploadBatchId: metadataValue(metadata.uploadBatchId) || undefined,
      });
  const destinationPath = path.join(destinationRoot, relativePath);
  const destinationDir = path.dirname(destinationPath);
  const logicalRelativePath = normalizeRelativePath(path.join(logicalBase, relativePath));
  const relDestDir = normalizeRelativePath(path.dirname(logicalRelativePath));

  if (!relDestDir || relDestDir.trim() === '') {
    throw tusError(
      400,
      'Cannot upload files to the root path. Please select a specific volume or folder first.'
    );
  }

  // Same reason as the direct upload path: the destination the client asked
  // for is authorized above, but the folder the file actually lands in comes
  // from a client-supplied relative path and must be authorized as well.
  if (relDestDir !== normalizeRelativePath(logicalBase)) {
    const { allowed: destAllowed, accessInfo: destAccess } = await authorizeAndResolve(
      context,
      relDestDir,
      ACTIONS.upload
    );
    if (!destAllowed) {
      throw tusError(403, destAccess?.denialReason || 'Cannot upload files to this path.');
    }
  }

  return {
    uploadTo,
    relativePath,
    destinationPath,
    destinationDir,
    logicalBase,
    logicalRelativePath,
  };
};

const validateExistingUploadAccess = async (req, uploadId) => {
  if (!uploadId) return;

  const { nodeReq } = getContext(req);
  if (!nodeReq?.user && !nodeReq?.guestSession) {
    throw tusError(401, 'Authentication required.');
  }

  const upload = await fileStore.getUpload(uploadId);
  await resolveTusUploadTarget(nodeReq, upload.metadata || {});
};

/**
 * Uploads whose last byte has arrived but whose file has not reached its
 * destination yet.
 *
 * Chunks are assembled in the cache directory and the finished file is moved
 * into place, which is instant on one filesystem and a byte-for-byte copy
 * across two — unavoidable here, since the volumes a user can upload to are
 * separate mounts. The client has finished sending by then, so its own progress
 * bar has nothing left to report and sits at 100% for as long as the copy runs.
 * On a multi-gigabyte file that reads as a freeze. These entries are what the
 * client polls to show the copy actually moving.
 */
const finalizations = new Map();

const ownerOf = (nodeReq) => nodeReq?.user?.id || nodeReq?.guestSession?.id || null;

const copyWithProgress = async (source, destination, onProgress) => {
  const readStream = fsSync.createReadStream(source);
  let copiedBytes = 0;

  readStream.on('data', (chunk) => {
    copiedBytes += chunk.length;
    onProgress(copiedBytes);
  });

  await pipeline(readStream, fsSync.createWriteStream(destination));
};

const moveFile = async (source, destination, onProgress) => {
  try {
    await fs.rename(source, destination);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
  }

  // Different filesystems: the bytes have to be read and written again. They
  // are written beside the destination under a hidden `.uploading` name and
  // only a whole file takes the real one, so a copy that fails, or a process
  // killed halfway, never leaves a truncated file where the user will open it.
  // The name does not derive from the file's own, which could then exceed the
  // filesystem's limit where the real name does not; the listing hides it, and
  // the remnant sweep recognises it where uploads land.
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.upload-${crypto.randomBytes(8).toString('hex')}${UPLOADING_SUFFIX}`
  );

  let finalPath = destination;
  try {
    await copyWithProgress(source, temporary, onProgress);

    // The name was free when it was chosen, but a long copy no longer holds it
    // the way a file being written under it did. Something that arrived
    // meanwhile is not overwritten: the upload takes the next free name.
    if (await pathExists(finalPath)) {
      finalPath = path.join(
        directory,
        await findAvailableName(directory, path.basename(destination))
      );
    }
    await fs.rename(temporary, finalPath);
  } catch (err) {
    try {
      await fs.rm(temporary, { force: true });
    } catch (cleanupErr) {
      logger.warn(
        { temporary, err: cleanupErr },
        'Failed to remove a partial copy of a TUS upload'
      );
    }
    throw err;
  }

  await fs.unlink(source);
  return finalPath;
};

/** What is still being written to its destination, for one user. */
const listFinalizations = (nodeReq) => {
  const owner = ownerOf(nodeReq);
  if (!owner) return [];

  return [...finalizations.values()]
    .filter((entry) => entry.owner === owner)
    .map(({ name, copiedBytes, totalBytes }) => ({ name, copiedBytes, totalBytes }));
};

const server = new Server({
  path: TUS_PATH,
  datastore: fileStore,
  relativeLocation: false,
  respectForwardedHeaders: true,
  allowedCredentials: true,
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Upload-Length',
    'Upload-Metadata',
    'Upload-Offset',
    'Tus-Resumable',
  ],
  exposedHeaders: [
    'Location',
    'Tus-Resumable',
    'Upload-Length',
    'Upload-Offset',
    'Upload-Metadata',
    'Upload-Expires',
  ],
  async onIncomingRequest(req, uploadId) {
    if (req.method === 'OPTIONS') {
      return;
    }

    await ensureTusEnabled();

    const { nodeReq } = getContext(req);
    if (!nodeReq?.user && !nodeReq?.guestSession) {
      throw tusError(401, 'Authentication required.');
    }

    if (req.method !== 'POST') {
      await validateExistingUploadAccess(req, uploadId);
    }
  },
  async onUploadCreate(req, upload) {
    await cleanupExpiredUploads();

    const { nodeReq } = getContext(req);
    const target = await resolveTusUploadTarget(nodeReq, upload.metadata || {});
    const uploadSize = Number.isFinite(upload.size) ? upload.size : null;

    // What a copy killed halfway left in the destination, as a direct upload
    // does before the same check: what it removes is space about to be measured.
    await sweepStaleUploadRemnants(target.destinationDir);

    await ensureTusStorageAvailable(TUS_CACHE_DIR, uploadSize, 'temporary upload storage');
    await ensureTusStorageAvailable(target.destinationDir, uploadSize, 'destination storage');

    return {
      metadata: {
        ...(upload.metadata || {}),
        uploadTo: target.uploadTo,
        relativePath: target.relativePath,
        resolvedRelativePath: target.relativePath,
        logicalBase: target.logicalBase,
        logicalRelativePath: target.logicalRelativePath,
      },
    };
  },
  async onUploadFinish(req, upload) {
    // Before anything is awaited, and until the metadata is gone too: the
    // cache sweep leaves an upload alone for as long as it is in this set.
    finishing.add(upload.id);
    try {
      const { nodeReq } = getContext(req);
      const target = await resolveTusUploadTarget(nodeReq, upload.metadata || {});
      const sourcePath = upload.storage?.path || path.join(TUS_CACHE_DIR, upload.id);

      await ensureDir(target.destinationDir);

      let finalPath = target.destinationPath;
      if (await pathExists(finalPath)) {
        const availableName = await findAvailableName(
          target.destinationDir,
          path.basename(target.destinationPath)
        );
        finalPath = path.join(target.destinationDir, availableName);
      }

      // Only reported once the copy starts moving: a rename within one filesystem
      // returns before the client could poll, and an entry stuck at zero bytes
      // would be worse than none at all.
      finalizations.set(upload.id, {
        name: path.basename(finalPath),
        copiedBytes: 0,
        totalBytes: Number.isFinite(upload.size) ? upload.size : 0,
        owner: ownerOf(nodeReq),
      });

      try {
        await moveFile(sourcePath, finalPath, (copiedBytes) => {
          const entry = finalizations.get(upload.id);
          if (entry) entry.copiedBytes = copiedBytes;
        });
      } finally {
        finalizations.delete(upload.id);
      }

      try {
        await fileStore.configstore.delete(upload.id);
      } catch (err) {
        logger.warn({ uploadId: upload.id, err }, 'Failed to remove TUS upload metadata');
      }

      return {};
    } finally {
      finishing.delete(upload.id);
    }
  },
  onResponseError(req, err) {
    logger.warn({ err, method: req.method, url: req.url }, 'TUS upload request failed');
  },
});

const handleTusUpload = async (req, res) => {
  const routerUrl = req.url;
  req.url = req.originalUrl || req.url;
  try {
    await server.handle(req, res);
  } finally {
    req.url = routerUrl;
  }
};

module.exports = {
  handleTusUpload,
  listFinalizations,
  cleanupExpiredUploads,
  cleanupInactiveUploads,
  startCacheSweep,
  stopCacheSweep,
};
