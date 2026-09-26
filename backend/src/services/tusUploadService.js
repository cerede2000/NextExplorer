const crypto = require('node:crypto');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('node:fs');
const { pipeline } = require('node:stream/promises');

const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');

const { uploads: uploadConfig } = require('../config');
const { ensureDir } = require('../utils/fsUtils');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
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
/**
 * Built on first use, not when this module is required.
 *
 * `FileStore` creates its directory in its constructor, which turns requiring
 * this file into a filesystem write — one that fails outright wherever the
 * cache directory is not there yet, including the check that every module
 * loads. A server that has never been asked to take an upload has no business
 * creating a cache for one either.
 */
let fileStoreInstance = null;
const store = () => {
  if (!fileStoreInstance) fileStoreInstance = new FileStore({ directory: TUS_CACHE_DIR });
  return fileStoreInstance;
};

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
    tusEnabledCache = { enabled: Boolean(settings.uploads?.chunkedEnabled), at: now };
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
 * Uploads being moved into place, whatever their age: by onUploadFinish, or by
 * a HEAD retrying a move that failed. Each holds the attempt, so a second
 * caller waits for it rather than placing the same file twice, and the upload
 * it is for.
 *
 * Age alone does not protect them. The last write refreshes the data file just
 * before the hook starts, but a copy to another filesystem can outlast the TTL
 * without touching the source again, and @tus/server calls the hook again for
 * an empty PATCH at the final offset — so a finished upload that has sat in the
 * cache for a day can be moving into place right now. The sweep asks this set
 * immediately before each removal, with nothing awaited in between.
 */
const finishing = new Map();

const cleanupInactiveUploads = async (now = Date.now()) => {
  if (TUS_INCOMPLETE_UPLOAD_TTL_MS <= 0) return 0;

  await ensureDir(TUS_CACHE_DIR);

  let entries;
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

  removedCount += await sweepFinishedRecords(now);

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

  // As the direct upload: a file may not land at the top, where a folder is a
  // mount rather than a folder in one.
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

  const upload = await store().getUpload(uploadId);
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

/**
 * Move a finished upload into `directory` under `desiredName`, or the first
 * free name after it, and answer the name and path it took.
 *
 * Nothing already holding the name is ever replaced. A name chosen beforehand
 * was free when it was chosen, not when the file arrived: whatever came under
 * it in between, another upload, a copy, a file saved over SMB, was replaced by
 * the rename at the end, which replaces a file silently.
 */
const moveFile = async (source, directory, desiredName, onProgress) => {
  // One filesystem: the cache file is linked under the name, which fails when
  // the name is taken and moves on to "name (1).ext".
  try {
    return await placeWithoutOverwrite(source, directory, desiredName);
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
  const temporary = path.join(
    directory,
    `.upload-${crypto.randomBytes(8).toString('hex')}${UPLOADING_SUFFIX}`
  );

  let placed;
  try {
    await copyWithProgress(source, temporary, onProgress);

    // A long copy holds no name while it runs, so the name is taken only now,
    // the same way: whatever arrived under it meanwhile is kept.
    placed = await placeWithoutOverwrite(temporary, directory, desiredName);
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

  try {
    await fs.unlink(source);
  } catch (err) {
    // The file is in its folder. Failing now would report it as never having
    // arrived, and a retry would place it a second time; the copy left in the
    // cache loses its metadata below, and the sweep removes it.
    logger.warn({ source, err }, 'A TUS upload was placed, but its cache copy stayed');
  }
  return placed;
};

/** What is still being written to its destination, for one user. */
const listFinalizations = (nodeReq) => {
  const owner = ownerOf(nodeReq);
  if (!owner) return [];

  return [...finalizations.values()]
    .filter((entry) => entry.owner === owner)
    .map(({ name, copiedBytes, totalBytes }) => ({ name, copiedBytes, totalBytes }));
};

/**
 * What the client is told when a finished upload could not be moved into its
 * folder: the file arrived, and why it is not where it was sent.
 *
 * Thrown, the failure became a 500 with a generic body, which the client
 * retried. A retry asks for the offset first, @tus/server answers it from the
 * cache, where the upload is complete, and tus-js-client then reported a file
 * that never arrived as uploaded, without another request. The reason travels
 * in a header as well as the body, since the client only reads headers, and
 * its presence is what tells the client not to retry.
 */
const FINALIZE_ERROR_HEADER = 'Upload-Finalize-Error';

const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

// Worded for the person reading it, never the raw message: those carry the
// server's own paths.
const FAILURE_REASONS = {
  EACCES: 'the server is not allowed to write there',
  EPERM: 'the server is not allowed to write there',
  EROFS: 'the volume is read-only',
  ENOENT: 'the folder, or the received file, is no longer there',
  ENOTDIR: 'the folder is no longer there',
  ENAMETOOLONG: 'the name is too long for that volume',
  EEXIST: 'no free name is left for it in that folder',
  EFBIG: 'the file is too large for that volume',
  EIO: 'the volume reported a read or write error',
};

const describeFinalizeFailure = (err) => {
  if (err instanceof InsufficientStorageError || STORAGE_FULL_CODES.has(err?.code)) {
    return { storageFull: true, reason: 'there is not enough space left on the volume' };
  }
  if (typeof err?.code === 'string' && FAILURE_REASONS[err.code]) {
    return { storageFull: false, reason: FAILURE_REASONS[err.code] };
  }
  // A refusal already worded for the person: this module's own, or an
  // application error.
  const worded = typeof err?.body === 'string' ? err.body : err?.isOperational ? err.message : '';
  return {
    storageFull: false,
    reason:
      String(worded || '')
        .trim()
        .replace(/\.$/, '') || 'the server ran into an unexpected error',
  };
};

const finalizeFailure = (err) => {
  const { storageFull, reason } = describeFinalizeFailure(err);
  const message = `The file was received, but it could not be put in its folder: ${reason}.`;
  return {
    status_code: storageFull ? 507 : 500,
    body: `${message}\n`,
    headers: { [FINALIZE_ERROR_HEADER]: encodeURIComponent(message) },
  };
};

/**
 * Uploads placed a moment ago, so a client asking for their offset afterwards
 * hears that they are complete.
 *
 * Once placed, an upload's cache entry is gone and @tus/server answers a HEAD
 * with 404, which tus-js-client takes as an upload to start over: a PATCH
 * whose response was lost during a long copy was retried, and the whole file
 * sent again and placed a second time. Kept as long as an unfinished upload is,
 * and for a bounded number of uploads.
 */
const FINISHED_MEMORY_MS =
  TUS_INCOMPLETE_UPLOAD_TTL_MS > 0 ? TUS_INCOMPLETE_UPLOAD_TTL_MS : 60 * 60 * 1000;
const FINISHED_MEMORY_LIMIT = 1000;
const finished = new Map();

const rememberFinished = (uploadId, entry) => {
  finished.delete(uploadId);
  finished.set(uploadId, { ...entry, at: Date.now() });
  // A Map iterates in insertion order: the first key is the oldest.
  while (finished.size > FINISHED_MEMORY_LIMIT) {
    finished.delete(finished.keys().next().value);
  }
};

const recallFinished = (uploadId) => {
  const entry = finished.get(uploadId);
  if (!entry) return null;
  if (Date.now() - entry.at > FINISHED_MEMORY_MS) {
    finished.delete(uploadId);
    return null;
  }
  return entry;
};

/**
 * The same, kept on disk beside the cache, for as long as the memory above.
 *
 * The memory goes with the process: a client asking for the offset of an
 * upload placed just before a restart got 404, and tus-js-client sent the
 * whole file again, into "name (1)". One small record per placed upload, read
 * only when the memory has nothing, and removed by the cache sweep.
 */
const FINISHED_RECORDS_DIR = TUS_CACHE_DIR ? path.join(TUS_CACHE_DIR, '.finished') : null;
const finishedRecordPath = (uploadId) => path.join(FINISHED_RECORDS_DIR, `${uploadId}.json`);

const recordFinished = async (uploadId, entry) => {
  if (!FINISHED_RECORDS_DIR) return;
  try {
    await ensureDir(FINISHED_RECORDS_DIR);
    await fs.writeFile(finishedRecordPath(uploadId), JSON.stringify({ ...entry, at: Date.now() }));
  } catch (err) {
    logger.debug({ err, uploadId }, 'A placed TUS upload could not be recorded on disk');
  }
};

const readFinishedRecord = async (uploadId) => {
  if (!FINISHED_RECORDS_DIR) return null;
  try {
    const entry = JSON.parse(await fs.readFile(finishedRecordPath(uploadId), 'utf8'));
    if (!Number.isFinite(entry?.at) || Date.now() - entry.at > FINISHED_MEMORY_MS) return null;
    return entry;
  } catch {
    return null;
  }
};

const sweepFinishedRecords = async (now = Date.now()) => {
  if (!FINISHED_RECORDS_DIR) return 0;
  let names;
  try {
    names = await fs.readdir(FINISHED_RECORDS_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(FINISHED_RECORDS_DIR, name);
    const stats = await safeStat(file);
    if (!stats || now - stats.mtimeMs < FINISHED_MEMORY_MS) continue;
    if (await rmIfExists(file)) removed += 1;
  }
  return removed;
};

const finalizeUpload = async (nodeReq, upload) => {
  const target = await resolveTusUploadTarget(nodeReq, upload.metadata || {});
  const sourcePath = upload.storage?.path || path.join(TUS_CACHE_DIR, upload.id);
  const desiredName = path.basename(target.destinationPath);
  const totalBytes = Number.isFinite(upload.size) ? upload.size : 0;
  const owner = ownerOf(nodeReq);

  await ensureDir(target.destinationDir);

  // Named as the client knows the file, which is how it finds the entry. The
  // name the file ends up under is taken once its bytes are in place, and the
  // entry goes away then.
  finalizations.set(upload.id, { name: desiredName, copiedBytes: 0, totalBytes, owner });

  let placed;
  try {
    placed = await moveFile(sourcePath, target.destinationDir, desiredName, (copiedBytes) => {
      const entry = finalizations.get(upload.id);
      if (entry) entry.copiedBytes = copiedBytes;
    });
  } finally {
    finalizations.delete(upload.id);
  }

  try {
    await store().configstore.delete(upload.id);
  } catch (err) {
    logger.warn({ uploadId: upload.id, err }, 'Failed to remove TUS upload metadata');
  }

  const result = { name: placed.name, path: placed.path, size: totalBytes, owner };
  rememberFinished(upload.id, result);
  await recordFinished(upload.id, result);
  return result;
};

/**
 * A move that keeps failing is logged as an error once for each reason, and
 * again for the same reason only at debug: every HEAD a client retries with
 * would otherwise write the same error line.
 */
const REPORTED_FAILURES_LIMIT = 1000;
const reportedFailures = new Map();

const reportFinalizeFailure = (uploadId, err) => {
  const reason = err?.code || err?.name || 'unknown';
  if (reportedFailures.get(uploadId) === reason) {
    logger.debug(
      { uploadId, err },
      'A finished TUS upload still could not be moved into its folder'
    );
    return;
  }
  reportedFailures.delete(uploadId);
  reportedFailures.set(uploadId, reason);
  while (reportedFailures.size > REPORTED_FAILURES_LIMIT) {
    reportedFailures.delete(reportedFailures.keys().next().value);
  }
  logger.error({ uploadId, err }, 'A finished TUS upload could not be moved into its folder');
};

/**
 * Move a finished upload into place once, however many ask: a caller arriving
 * while it moves waits for that attempt, and one arriving after it succeeded
 * gets its result.
 */
const finalizeOnce = (nodeReq, upload) => {
  const running = finishing.get(upload.id);
  if (running) return running.promise;
  const done = recallFinished(upload.id);
  if (done) return Promise.resolve(done);

  // Registered before anything is awaited, and until the metadata is gone too:
  // the cache sweep leaves an upload alone for as long as it is in `finishing`.
  const promise = finalizeUpload(nodeReq, upload)
    .then((result) => {
      reportedFailures.delete(upload.id);
      return result;
    })
    .catch((err) => {
      reportFinalizeFailure(upload.id, err);
      throw err;
    })
    .finally(() => {
      finishing.delete(upload.id);
    });
  finishing.set(upload.id, { promise, upload });
  return promise;
};

const TUS_RESUMABLE = '1.0.0';

const EXPOSED_HEADERS = [
  'Location',
  'Tus-Resumable',
  'Upload-Length',
  'Upload-Offset',
  'Upload-Metadata',
  'Upload-Expires',
  // Read by the client from a failed PATCH or HEAD; a cross-origin client
  // cannot see a header that is not exposed.
  FINALIZE_ERROR_HEADER,
];

/**
 * Same reason as the store below it: the server owns the store, so building it
 * eagerly would build the store eagerly too.
 */
let serverInstance = null;
const tusServer = () => {
  if (!serverInstance) serverInstance = buildServer();
  return serverInstance;
};

const buildServer = () =>
  new Server({
    path: TUS_PATH,
    datastore: store(),
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
    exposedHeaders: EXPOSED_HEADERS,
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
      const { nodeReq } = getContext(req);
      try {
        await finalizeOnce(nodeReq, upload);
        return {};
      } catch (err) {
        // Answered rather than thrown: see finalizeFailure.
        return finalizeFailure(err);
      }
    },
    onResponseError(req, err) {
      logger.warn({ err, method: req.method, url: req.url }, 'TUS upload request failed');
    },
  });

// The upload's id, the last segment after the TUS path — wherever the app is
// mounted, as @tus/server itself reads it.
const UPLOAD_ID_PATTERN = new RegExp(`${TUS_PATH}/([A-Za-z0-9_-]+)/?$`);

const uploadIdFromRequest = (req) => {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return UPLOAD_ID_PATTERN.exec(pathname)?.[1] || null;
};

const answerHead = (req, res, status, headers) => {
  res.writeHead(status, {
    'Tus-Resumable': TUS_RESUMABLE,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': tusServer().getCorsOrigin(req.headers.origin),
    'Access-Control-Expose-Headers': EXPOSED_HEADERS.join(', '),
    'Access-Control-Allow-Credentials': 'true',
    ...headers,
  });
  res.end();
};

const answerComplete = (req, res, size) =>
  answerHead(req, res, 200, { 'Upload-Offset': String(size), 'Upload-Length': String(size) });

/**
 * 423, not the 500 or 507 a PATCH answers with. tus-js-client takes any other
 * refusal of a HEAD as an upload that no longer exists and silently creates a
 * new one, sending the whole file again; a locked upload is the one it reports
 * as an error, which is where the client reads the header.
 */
const answerFinalizeFailure = (req, res, err) => {
  answerHead(req, res, 423, finalizeFailure(err).headers);
};

/**
 * Answer a client asking for the offset of an upload whose bytes have all
 * arrived, and answer it with the truth about the file, not the cache.
 *
 * - Placed a moment ago: complete, where @tus/server would answer 404 and the
 *   client would send the whole file again.
 * - Being placed right now: complete once that attempt succeeds.
 * - Complete in the cache and not moving, because the move failed or the
 *   server restarted: the move is tried again, and the answer is complete only
 *   if it succeeds. @tus/server would answer complete from the cache, and the
 *   client would report the upload as done without another request.
 *
 * Anything else, and anything the usual gate refuses, is left to @tus/server.
 * Answers whether it answered.
 */
const answerFinishedUploadHead = async (req, res) => {
  const uploadId = uploadIdFromRequest(req);
  if (!uploadId || !req.headers['tus-resumable']) return false;

  try {
    await ensureTusEnabled();
  } catch {
    return false;
  }
  const owner = ownerOf(req);
  if (!owner) return false;

  const done = recallFinished(uploadId) || (await readFinishedRecord(uploadId));
  if (done) {
    if (done.owner !== owner) return false;
    answerComplete(req, res, done.size);
    return true;
  }

  let upload = finishing.get(uploadId)?.upload;
  if (!upload) {
    try {
      upload = await store().getUpload(uploadId);
    } catch {
      return false;
    }
    if (!Number.isFinite(upload.size) || upload.offset !== upload.size) return false;
  }

  // Authorised as the PATCH was, with this request's user: the move below
  // resolves the folder with the same user again.
  try {
    await resolveTusUploadTarget(req, upload.metadata || {});
  } catch {
    return false;
  }

  try {
    const result = await finalizeOnce(req, upload);
    answerComplete(req, res, result.size);
  } catch (err) {
    answerFinalizeFailure(req, res, err);
  }
  return true;
};

const handleTusUpload = async (req, res) => {
  if (req.method === 'HEAD' && (await answerFinishedUploadHead(req, res))) return;

  const routerUrl = req.url;
  req.url = req.originalUrl || req.url;
  try {
    await tusServer().handle(req, res);
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
