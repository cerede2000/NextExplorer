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
const { resolveFolderUploadRelativePath } = require('./uploadFolderTargetService');
const { ensureStorageAvailable } = require('./uploadStorageGuard');
const { sweepStaleUploadRemnants, UPLOADING_SUFFIX } = require('./uploadRemnants');
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
  const resolvedRelativePathMeta = readUploadRoutingValue(req, 'resolvedRelativePath');
  const uploadToMeta = readUploadRoutingValue(req, 'uploadTo');

  const uploadTo = normalizeRelativePath(uploadToMeta);
  const requestedRelativePath =
    normalizeRelativePath(resolvedRelativePathMeta || relativePathMeta) ||
    path.basename(file.originalname);
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
  const relativePath = resolvedRelativePathMeta
    ? requestedRelativePath
    : await resolveFolderUploadRelativePath({
        relativePath: requestedRelativePath,
        destinationRoot,
        // The reservation creates the folder the batch lands in, and it is
        // authorized by its logical path, not by where it sits on disk.
        logicalBase,
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

/**
 * Clear the remains of dead uploads from the destination, then refuse this one
 * if what is coming will not fit.
 *
 * Once per destination, not once per request. Multer hands files over one at a
 * time and knows no size in advance, so the only measure of what is coming is
 * the request's Content-Length — which covers the whole body. Checking that
 * again for each later file going to the *same* folder would weigh the whole
 * body against the space left after the earlier ones had landed, and refuse an
 * upload that fits.
 *
 * A folder this request has not written to yet is a different matter, and used
 * to be missed entirely: each file carries its own relative path, so one
 * request can reach several folders, and on a machine with more than one disk
 * that is several disks. The second one had its free space never measured and
 * its dead uploads never swept — and the answer for it is the first one's
 * reasoning, unchanged: nothing of this request has landed there either.
 *
 * The sweep comes first because what it removes is space the check is about to
 * measure.
 */
const REQUEST_PREPARED = Symbol('uploadDestinationsPrepared');

const prepareDestinationOnce = async (req, destinationDir) => {
  const prepared = (req[REQUEST_PREPARED] ??= new Set());
  if (prepared.has(destinationDir)) return;
  prepared.add(destinationDir);

  await sweepStaleUploadRemnants(destinationDir);

  // A request that announces no size — chunked, which is what an API client
  // sending a stream does — used to skip the check altogether: the guard takes
  // a number and was handed nothing, so an upload could fill a volume that was
  // already past its reserve, on a machine where a full volume takes the
  // database down with it. Zero is what is honestly known about what is
  // coming, and it still holds the reserve itself free.
  const declaredBytes = Number(req.headers?.['content-length']);
  await ensureStorageAvailable(
    destinationDir,
    Number.isFinite(declaredBytes) ? declaredBytes : 0,
    'destination storage'
  );
};

/**
 * Remove the folders this upload created, while they are still empty.
 *
 * `mkdir` with `recursive` answers the topmost folder it had to create, so
 * what lies between that and the destination is exactly what this file added.
 * A refusal after that point — no space left, a file over the size limit, a
 * client that went away — used to leave them behind: empty folders an upload
 * invented, in somebody's tree, with nothing to say where they came from.
 *
 * Deepest first, and each one only if nothing is in it. Another file of the
 * same request may have landed in the very folder this one created, so the
 * guard is `rmdir` refusing a folder that is not empty rather than a check of
 * our own, which could be out of date by the time it is acted on.
 */
const removeEmptyCreatedDirectories = async (deepestPath, topmostCreated) => {
  if (!topmostCreated) return;

  let current = deepestPath;
  for (;;) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      // Already gone: whatever removed it may have left its parents, which are
      // as much ours as it was. Anything else — a folder somebody has put a
      // file in, a permission — is where this stops.
      if (error?.code !== 'ENOENT') return;
    }
    if (current === topmostCreated) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
};

function CustomStorage() {
  // Custom multer storage engine for handling file uploads with:
  // - Access control checks
  // - Atomic-like writes via temporary files
  // - A name that never replaces a file already holding it
}

CustomStorage.prototype._handleFile = function handleFile(req, file, cb) {
  (async () => {
    // What this file had to create to have somewhere to land, and where it was
    // going: enough to undo it if the upload is refused after this point.
    let createdDirectoryRoot = null;
    let preparedDestinationDir = null;
    // Recorded while the bytes arrive, released however the upload ends: a stop
    // half-way leaves the record, and the sweep at the next start removes the
    // hidden file it names.
    let inFlight = null;
    const fail = async (error) => {
      inFlight?.release();
      await removeEmptyCreatedDirectories(preparedDestinationDir, createdDirectoryRoot);
      cb(error);
    };

    try {
      const { destinationPath, destinationDir, logicalRelativePath, logicalBase } =
        await resolveUploadPaths(req, file);

      const relDestDir = normalizeRelativePath(path.dirname(logicalRelativePath));

      // Prevent uploading directly to the root path (no space / volume
      // selected).
      if (!relDestDir || relDestDir.trim() === '') {
        throw new ValidationError(
          'Cannot upload files to the root path. Please select a specific volume or folder first.'
        );
      }

      // The authorization above covers the chosen destination; the file also
      // carries a client-supplied relative path, so the folder it actually
      // lands in has to be authorized too. Otherwise a subfolder an admin
      // marked read-only or hidden would still accept uploads.
      if (relDestDir !== normalizeRelativePath(logicalBase)) {
        const context = { user: req.user, guestSession: req.guestSession };
        const { allowed: destAllowed, accessInfo: destAccess } = await authorizeAndResolve(
          context,
          relDestDir,
          ACTIONS.upload
        );
        if (!destAllowed) {
          throw new ForbiddenError(destAccess?.denialReason || 'Cannot upload files to this path.');
        }
      }

      createdDirectoryRoot = (await ensureDir(destinationDir)) || null;
      preparedDestinationDir = destinationDir;
      await prepareDestinationOnce(req, destinationDir);

      // The bytes go to a hidden name of their own beside the destination, and
      // the real name is only taken once they are all there. Choosing that name
      // first, as this did, left it free for the whole transfer: whatever
      // arrived under it meanwhile — another upload, a copy, a file saved over
      // SMB — was replaced by the rename at the end, and two uploads of the same
      // name wrote into the same temporary file. The temporary name is random,
      // so it never collides and never derives from a name that could exceed
      // the filesystem's limit, and it still ends in `.uploading`, which the
      // listing hides and the remnant sweep recognises.
      const desiredName = path.basename(destinationPath);
      const temporaryPath = path.join(
        destinationDir,
        `.upload-${crypto.randomBytes(8).toString('hex')}${UPLOADING_SUFFIX}`
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
      let inactivityTimer = null;
      const inactivityTimeoutMs = uploads?.inactivityTimeoutMs ?? 120000;

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
        await fail(error);
        return;
      } finally {
        clearInactivityTimer();
        file.stream.off('data', refreshInactivityTimer);
        req.off('aborted', handleAbort);
        req.off('close', handleClose);
      }

      // The parser stops a file at the size limit by ending its stream early,
      // so to the storage a truncated file looks like a complete one: it was
      // put under the name it asked for, and only removed once the refusal had
      // travelled back up through multer. A refused upload must never hold the
      // name it asked for, not even for that instant — the name is one another
      // upload may be asking for at the same moment, and a listing in between
      // answers with a file that is not what it says it is. The refusal is
      // multer's own, so the client is told what it was already going to be
      // told, with this route's sentence and its 413.
      if (file.stream?.truncated) {
        const truncatedError = new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname);
        await waitForClosed(outStream);
        await cleanupTemporary();
        await fail(truncatedError);
        return;
      }

      try {
        // Taken by an operation that fails when the name is held, moving on to
        // "name (1).ext" and so on: nothing already there is ever replaced. What
        // was taken is what the response reports.
        const placed = await placeWithoutOverwrite(temporaryPath, destinationDir, desiredName);
        inFlight?.release();
        cb(null, {
          path: placed.path,
          size: outStream.bytesWritten,
          filename: placed.name,
          logicalPath: normalizeRelativePath(path.join(relDestDir, placed.name)),
        });
      } catch (placeErr) {
        await waitForClosed(outStream);
        await cleanupTemporary();
        await fail(placeErr);
      }
    } catch (uploadError) {
      await fail(uploadError);
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
