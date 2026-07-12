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
const TUS_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let lastCleanupAt = 0;

const fileStore = new FileStore({
  directory: TUS_CACHE_DIR,
  expirationPeriodInMilliseconds: TUS_EXPIRATION_MS,
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

const ensureTusEnabled = async () => {
  const settings = await getSystemSettings();
  if (!settings.uploads?.chunkedEnabled) {
    throw tusError(403, 'Chunked uploads are disabled.');
  }
};

const cleanupExpiredUploads = async () => {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  try {
    await fileStore.deleteExpired();
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up expired TUS uploads');
  }
};

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
};
