const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { finished, pipeline } = require('stream/promises');
const multer = require('multer');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const { normalizeRelativePath, findAvailableName } = require('../utils/pathUtils');
const { readMetaField } = require('../utils/requestUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { resolveFolderUploadRelativePath } = require('./uploadFolderTargetService');
const { ForbiddenError, ValidationError } = require('../errors/AppError');
const logger = require('../utils/logger');
const { upload: uploadConfig } = require('../config');

const RETRYABLE_CLEANUP_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForClosed = async (stream) => {
  if (!stream || stream.closed) return;
  try {
    await finished(stream);
  } catch (_) {
    // A destroyed stream often reports the original abort/error here; the close is what matters.
  }
};

const destroyStream = (stream, error) => {
  if (!stream || stream.destroyed) return;
  stream.destroy(error);
};

const createUploadAbortedError = () => {
  const error = new Error('Upload aborted by the client.');
  error.code = 'UPLOAD_ABORTED';
  return error;
};

const createUploadInactiveError = (timeoutMs) => {
  const error = new Error(`Upload aborted after ${timeoutMs}ms without receiving data.`);
  error.code = 'UPLOAD_INACTIVITY_TIMEOUT';
  return error;
};

const readUploadRoutingValue = (req, key) => {
  const queryValue = req?.query?.[key];
  if (typeof queryValue === 'string') return queryValue;
  return readMetaField(req, key);
};

const resolveUploadPaths = async (req, file) => {
  const relativePathMeta = readUploadRoutingValue(req, 'relativePath');
  const uploadToMeta = readUploadRoutingValue(req, 'uploadTo');

  const uploadTo = normalizeRelativePath(uploadToMeta);
  const requestedRelativePath =
    normalizeRelativePath(relativePathMeta) || path.basename(file.originalname);
  // Multer can enter the storage callback before trailing multipart metadata
  // has populated req.body. The client supplies these routing fields in the
  // query string too, so every file of a picked folder gets the same target.
  const uploadBatchId = readUploadRoutingValue(req, 'uploadBatchId');

  const context = { user: req.user, guestSession: req.guestSession };
  const { allowed, accessInfo, resolved } = await authorizeAndResolve(
    context,
    uploadTo,
    ACTIONS.upload
  );
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Cannot upload files to this path.');
  }

  const { absolutePath: destinationRoot, relativePath: logicalBase } = resolved;
  const relativePath = await resolveFolderUploadRelativePath({
    relativePath: requestedRelativePath,
    destinationRoot,
    context,
    uploadBatchId,
  });

  const destinationPath = path.join(destinationRoot, relativePath);
  const destinationDir = path.dirname(destinationPath);

  return {
    destinationPath,
    destinationDir,
    logicalBase,
    logicalRelativePath: normalizeRelativePath(path.join(logicalBase, relativePath)),
  };
};

function CustomStorage() {
  // Custom multer storage engine for handling file uploads with:
  // - Access control checks
  // - Atomic-like writes via temporary files
  // - Automatic file name conflict resolution
}

CustomStorage.prototype._handleFile = function handleFile(req, file, cb) {
  (async () => {
    try {
      const { destinationPath, destinationDir, logicalRelativePath } = await resolveUploadPaths(
        req,
        file
      );

      // Enforce access control: destination directory must be writable
      const relDestDir = normalizeRelativePath(path.dirname(logicalRelativePath));

      // Prevent uploading directly to the root path (no space / volume selected)
      if (!relDestDir || relDestDir.trim() === '') {
        throw new ValidationError(
          'Cannot upload files to the root path. Please select a specific volume or folder first.'
        );
      }

      await ensureDir(destinationDir);

      let finalPath = destinationPath;
      if (await pathExists(finalPath)) {
        const desiredName = path.basename(destinationPath);
        const availableName = await findAvailableName(destinationDir, desiredName);
        finalPath = path.join(destinationDir, availableName);
      }

      const temporaryPath = `${finalPath}.uploading`;

      const cleanupTemporary = async () => {
        let lastError = null;

        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            if (await pathExists(temporaryPath)) {
              await fs.rm(temporaryPath, { force: true });
            }
            return;
          } catch (cleanupErr) {
            lastError = cleanupErr;
            if (!RETRYABLE_CLEANUP_ERRORS.has(cleanupErr?.code) || attempt === 5) {
              break;
            }
            await delay(50 * (attempt + 1));
          }
        }

        logger.error({ temporaryPath, err: lastError }, 'Failed to remove temporary upload file');
      };

      const outStream = fss.createWriteStream(temporaryPath);
      let uploadAborted = false;
      let uploadFinished = false;
      let abortError = null;
      let inactivityTimer = null;
      const inactivityTimeoutMs = uploadConfig?.inactivityTimeoutMs ?? 120000;

      const clearInactivityTimer = () => {
        if (!inactivityTimer) return;
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      };

      const handleAbort = (error = createUploadAbortedError()) => {
        if (uploadFinished || uploadAborted) return;
        uploadAborted = true;
        abortError = error instanceof Error ? error : createUploadAbortedError();
        clearInactivityTimer();
        try {
          file.stream.unpipe(outStream);
        } catch (_) {
          /* noop */
        }
        destroyStream(file.stream, abortError);
        destroyStream(outStream, abortError);
      };

      const refreshInactivityTimer = () => {
        if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) return;
        clearInactivityTimer();
        inactivityTimer = setTimeout(() => {
          handleAbort(createUploadInactiveError(inactivityTimeoutMs));
        }, inactivityTimeoutMs);
        inactivityTimer.unref?.();
      };

      const handleClose = () => {
        if (!req.complete) {
          handleAbort();
        }
      };

      req.once('aborted', handleAbort);
      req.once('close', handleClose);
      file.stream.on('data', refreshInactivityTimer);
      refreshInactivityTimer();

      try {
        await pipeline(file.stream, outStream);
        uploadFinished = true;
      } catch (streamErr) {
        const error = uploadAborted ? abortError || streamErr : streamErr;
        destroyStream(file.stream, error);
        destroyStream(outStream, error);
        await waitForClosed(outStream);
        await cleanupTemporary();
        cb(error);
        return;
      } finally {
        clearInactivityTimer();
        file.stream.off('data', refreshInactivityTimer);
        req.off('aborted', handleAbort);
        req.off('close', handleClose);
      }

      try {
        await fs.rename(temporaryPath, finalPath);
        cb(null, {
          path: finalPath,
          size: outStream.bytesWritten,
          filename: path.basename(finalPath),
          logicalPath: logicalRelativePath,
        });
      } catch (renameErr) {
        await waitForClosed(outStream);
        await cleanupTemporary();
        cb(renameErr);
      }
    } catch (uploadError) {
      cb(uploadError);
    }
  })();
};

CustomStorage.prototype._removeFile = function removeFile(req, file, cb) {
  if (!file || !file.path) {
    cb(null);
    return;
  }

  fs.unlink(file.path)
    .then(() => cb(null))
    .catch((error) => {
      if (error && error.code === 'ENOENT') {
        cb(null);
        return;
      }
      cb(error);
    });
};

const createUploadMiddleware = () => multer({ storage: new CustomStorage() });

module.exports = {
  createUploadMiddleware,
};
