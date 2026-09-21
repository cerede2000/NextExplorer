const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { finished, pipeline } = require('stream/promises');
const multer = require('multer');

const { uploads } = require('../config/index');
const { ensureDir, pathExists } = require('../utils/fsUtils');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const { readMetaField } = require('../utils/requestUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { track: trackInFlight } = require('./inFlightFiles');
const { ForbiddenError, ValidationError } = require('../errors/AppError');
const logger = require('../utils/logger');

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

const resolveUploadPaths = async (req, file) => {
  const relativePathMeta = readMetaField(req, 'relativePath');
  const uploadToMeta = readMetaField(req, 'uploadTo');

  const uploadTo = normalizeRelativePath(uploadToMeta);
  const relativePath = normalizeRelativePath(relativePathMeta) || path.basename(file.originalname);

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
  // - A name that never replaces a file already holding it
}

CustomStorage.prototype._handleFile = function handleFile(req, file, cb) {
  // Recorded while the bytes arrive, released however the upload ends: a stop
  // half-way leaves the record, and the next start removes the hidden file.
  let inFlight = null;
  const finish = (...args) => {
    inFlight?.release();
    cb(...args);
  };
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

      // The bytes go to a hidden name of their own beside the destination, and
      // the real name is only taken once they are all there. Choosing that name
      // first, as this did, left it free for the whole transfer: whatever
      // arrived under it meanwhile — another upload, a copy, a file saved over
      // SMB — was replaced by the rename at the end, and two uploads of the same
      // name wrote into the same temporary file. The temporary name is random,
      // so it never collides and never derives from a name that could exceed
      // the filesystem's limit, and it starts with a dot, which the listing
      // hides unless hidden files are shown.
      const desiredName = path.basename(destinationPath);
      const temporaryPath = path.join(
        destinationDir,
        `.upload-${crypto.randomBytes(8).toString('hex')}.uploading`
      );
      inFlight = trackInFlight(temporaryPath, 'partial-upload');

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

      const handleAbort = () => {
        if (uploadFinished || uploadAborted) return;
        uploadAborted = true;
        abortError = createUploadAbortedError();
        try {
          file.stream.unpipe(outStream);
        } catch (_) {
          /* noop */
        }
        destroyStream(file.stream, abortError);
        destroyStream(outStream, abortError);
      };

      const handleClose = () => {
        if (!req.complete) {
          handleAbort();
        }
      };

      req.once('aborted', handleAbort);
      req.once('close', handleClose);

      try {
        await pipeline(file.stream, outStream);
        uploadFinished = true;
      } catch (streamErr) {
        const error = uploadAborted ? abortError || streamErr : streamErr;
        destroyStream(file.stream, error);
        destroyStream(outStream, error);
        await waitForClosed(outStream);
        await cleanupTemporary();
        finish(error);
        return;
      } finally {
        req.off('aborted', handleAbort);
        req.off('close', handleClose);
      }

      try {
        // Taken by an operation that fails when the name is held, moving on to
        // "name (1).ext" and so on: nothing already there is ever replaced. What
        // was taken is what the response reports.
        const placed = await placeWithoutOverwrite(temporaryPath, destinationDir, desiredName);
        finish(null, {
          path: placed.path,
          size: outStream.bytesWritten,
          filename: placed.name,
          logicalPath: normalizeRelativePath(path.join(relDestDir, placed.name)),
        });
      } catch (placeErr) {
        await waitForClosed(outStream);
        await cleanupTemporary();
        finish(placeErr);
      }
    } catch (uploadError) {
      finish(uploadError);
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

/**
 * Direct (non-chunked) uploads.
 *
 * Multer applies no limit of its own, so without these a single request could
 * stream until the volume is full. The file size ceiling is deliberately high
 * — this is a file manager, large files are the point — but the field limits
 * keep a malformed or hostile multipart body from being parsed indefinitely.
 */
const createUploadMiddleware = () =>
  multer({
    storage: new CustomStorage(),
    limits: {
      fileSize: uploads.maxDirectUploadBytes,
      files: uploads.maxFilesPerRequest,
      fields: 50,
      fieldSize: 1024 * 1024,
      headerPairs: 200,
    },
  });

module.exports = {
  createUploadMiddleware,
};
