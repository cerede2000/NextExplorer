const path = require('path');
const fs = require('fs/promises');

const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');

const { upload: uploadConfig } = require('../config');
const { ensureDir, pathExists } = require('../utils/fsUtils');
const { normalizeRelativePath, findAvailableName } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { getSystemSettings } = require('./settingsService');
const logger = require('../utils/logger');

const TUS_PATH = '/api/upload/tus';
const TUS_CACHE_DIR = uploadConfig?.tusUploadDir;
const TUS_INCOMPLETE_UPLOAD_TTL_MS = uploadConfig?.tusIncompleteUploadTtlMs ?? 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = uploadConfig?.tusCleanupIntervalMs ?? 10 * 60 * 1000;

let lastCleanupAt = 0;

const fileStore = new FileStore({
  directory: TUS_CACHE_DIR,
  expirationPeriodInMilliseconds: TUS_INCOMPLETE_UPLOAD_TTL_MS,
});

const tusError = (statusCode, message) => ({
  status_code: statusCode,
  body: `${message}\n`,
});

const getAvailableBytes = async (directory) => {
  if (typeof fs.statfs !== 'function') {
    return null;
  }

  try {
    await ensureDir(directory);
    const stats = await fs.statfs(directory);
    return stats.bavail * stats.bsize;
  } catch (err) {
    logger.warn({ directory, err }, 'Unable to inspect available storage for uploads');
    return null;
  }
};

const ensureStorageAvailable = async (directory, uploadSize, label) => {
  if (!Number.isFinite(uploadSize) || uploadSize < 0) {
    return;
  }

  const availableBytes = await getAvailableBytes(directory);
  if (!Number.isFinite(availableBytes)) {
    return;
  }

  const reserveBytes = uploadConfig?.storageReserveBytes ?? 64 * 1024 * 1024;
  const requiredBytes = uploadSize + reserveBytes;
  if (availableBytes < requiredBytes) {
    throw tusError(
      507,
      `Not enough storage available in ${label}. Required ${requiredBytes} bytes including reserve, available ${availableBytes} bytes.`
    );
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
      enabled: Boolean(
        settings.uploads?.chunkedEnabled || settings.uploads?.chunkedAutoFallback
      ),
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

    if (!dataStats) {
      if (await rmIfExists(metadataPath)) removedCount += 1;
      continue;
    }

    const expectedSize = Number(metadata?.size);
    const isIncomplete = !Number.isFinite(expectedSize) || dataStats.size < expectedSize;
    if (!isIncomplete) continue;

    const removed = await Promise.all([rmIfExists(dataPath), rmIfExists(metadataPath)]);
    removedCount += removed.filter(Boolean).length;
  }

  if (removedCount > 0) {
    logger.info({ removedCount }, 'Cleaned stale TUS upload cache files');
  }

  return removedCount;
};

const cleanupExpiredUploads = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  try {
    await ensureDir(TUS_CACHE_DIR);
  } catch (err) {
    logger.warn({ err }, 'Failed to prepare TUS upload cache for cleanup');
    return;
  }

  try {
    await fileStore.deleteExpired();
  } catch (err) {
    const message = String(err?.body || err?.message || '');
    if (err?.code !== 'ENOENT' && !message.includes('not found')) {
      logger.warn({ err }, 'Failed to clean up expired TUS uploads');
    }
  }

  try {
    await cleanupInactiveUploads(now);
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up inactive TUS uploads');
  }
};

cleanupExpiredUploads({ force: true }).catch((err) => {
  logger.warn({ err }, 'Failed to run initial TUS upload cleanup');
});

const resolveTusUploadTarget = async (nodeReq, metadata = {}) => {
  const filename =
    typeof metadata.filename === 'string' && metadata.filename.trim()
      ? metadata.filename.trim()
      : 'upload';
  const uploadTo = normalizeRelativePath(metadata.uploadTo || '');
  const relativePath =
    normalizeRelativePath(metadata.relativePath || filename) || path.basename(filename);

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

const moveFile = async (source, destination) => {
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
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

    await ensureStorageAvailable(TUS_CACHE_DIR, uploadSize, 'temporary upload storage');
    await ensureStorageAvailable(target.destinationDir, uploadSize, 'destination storage');

    return {
      metadata: {
        ...(upload.metadata || {}),
        uploadTo: target.uploadTo,
        relativePath: target.relativePath,
        logicalBase: target.logicalBase,
        logicalRelativePath: target.logicalRelativePath,
      },
    };
  },
  async onUploadFinish(req, upload) {
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

    await moveFile(sourcePath, finalPath);

    try {
      await fileStore.configstore.delete(upload.id);
    } catch (err) {
      logger.warn({ uploadId: upload.id, err }, 'Failed to remove TUS upload metadata');
    }

    return {};
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
  cleanupExpiredUploads,
  cleanupInactiveUploads,
};
