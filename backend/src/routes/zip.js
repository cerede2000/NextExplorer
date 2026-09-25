const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const AdmZip = require('adm-zip');

const asyncHandler = require('../utils/asyncHandler');
const { mapWithConcurrency } = require('../utils/mapWithConcurrency');
const { startNdjsonStream, throttlePercent } = require('../utils/ndjsonStream');
const logger = require('../utils/logger');
const { pathExists } = require('../utils/fsUtils');
const {
  normalizeRelativePath,
  combineRelativePath,
  ensureValidName,
} = require('../utils/pathUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const { takeInventory, removeInventoried } = require('../utils/ownedTree');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const { track: trackInFlight } = require('../services/inFlightFiles');
const {
  getSupportedArchiveExtensions,
  isSevenZipAvailable,
  readArchiveFootprint,
  extractArchive,
  createZipArchive,
  archiveBaseName,
  normalizeArchivePassword,
} = require('../services/archiveService');
const { collectArchiveEntries, writeZipFile } = require('../services/archiveTree');
const { archives } = require('../config/index');

const router = express.Router();

/**
 * Refuse archives that would expand far beyond their own size.
 *
 * Extraction is otherwise unbounded: a few kilobytes of nested, highly
 * compressible entries can fill the volume ("zip bomb"). The declared sizes
 * come from the archive itself, so this is a cheap pre-flight check, not a
 * guarantee — it stops the accidental and the trivially malicious case.
 */
const ensureArchiveWithinLimits = ({ entryCount = 0, totalBytes = 0 }) => {
  if (entryCount > archives.maxEntries) {
    throw new ValidationError(
      `This archive holds more than ${archives.maxEntries} entries and was not extracted.`
    );
  }
  if (totalBytes > archives.maxExtractedBytes) {
    throw new ValidationError(
      'This archive expands beyond the allowed size and was not extracted.'
    );
  }
};

/** Declared footprint of a zip read by the bundled JS extractor. */
const admZipFootprint = (entries = []) => ({
  entryCount: entries.length,
  totalBytes: entries.reduce((total, entry) => total + (entry?.header?.size || 0), 0),
});

const buildItemMetadata = async (absolutePath, relativeParent, name) => {
  const stats = await fs.stat(absolutePath);
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = stats.isDirectory() ? 'directory' : ext.length > 10 ? 'unknown' : ext || 'unknown';

  return { name, path: relativeParent, kind, size: stats.size, dateModified: stats.mtime };
};

const defaultZipNameForItems = (items = []) => {
  if (!Array.isArray(items) || items.length === 0) return 'Archive.zip';
  if (items.length > 1) return 'Archive.zip';

  const { name = '', kind = '' } = items[0] || {};
  if (!name) return 'Archive.zip';

  if (String(kind).toLowerCase() === 'directory') return `${name}.zip`;

  const ext = path.extname(name);
  return `${ext ? name.slice(0, -ext.length) : name}.zip`;
};

const extractIntoCurrentFolder = async ({
  stagingDirectory,
  destinationDirectory,
  relativeParentPath,
  movedPaths,
}) => {
  const stagedEntries = await fs.readdir(stagingDirectory, { withFileTypes: true });
  const items = [];

  for (const entry of stagedEntries) {
    const entryName = ensureValidName(entry.name);
    const sourcePath = path.join(stagingDirectory, entryName);
    // Taken stock of before it moves: undoing the extraction removes exactly
    // this, and not what someone puts in a placed folder afterwards.
    const inventory = await takeInventory(sourcePath);
    // The name is taken by the move itself, never looked at first and renamed
    // into later: a file, or an empty folder, that appears under it meanwhile
    // stays as it is, and the entry goes to "name (1)".
    const { name: destinationName, path: destinationPath } = await placeWithoutOverwrite(
      sourcePath,
      destinationDirectory,
      entryName
    );
    movedPaths.push({ path: destinationPath, inventory });

    items.push(await buildItemMetadata(destinationPath, relativeParentPath, destinationName));
  }

  return items;
};

router.post(
  '/files/zip/extract',
  asyncHandler(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    const inputPath = req.body?.path ?? '';
    const destination = req.body?.destination ?? 'folder';
    const archivePassword = normalizeArchivePassword(req.body?.password);
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      throw new ValidationError('An archive file path is required.');
    }
    if (destination !== 'folder' && destination !== 'current') {
      throw new ValidationError('Invalid archive extraction destination.');
    }

    const relativePath = normalizeRelativePath(inputPath);
    const context = { user: req.user, guestSession: req.guestSession };

    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      relativePath,
      ACTIONS.read
    ).catch(() => {
      throw new NotFoundError('File not found.');
    });
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
    }

    const zipAbsolutePath = resolved.absolutePath;
    if (!(await pathExists(zipAbsolutePath))) throw new NotFoundError('File not found.');

    const stats = await fs.stat(zipAbsolutePath);
    if (!stats.isFile()) throw new ValidationError('Only archive files can be extracted.');

    const archiveExtension = path.extname(zipAbsolutePath).slice(1).toLowerCase();
    const supportedExtensions = await getSupportedArchiveExtensions();
    if (!supportedExtensions.includes(archiveExtension)) {
      throw new ValidationError(
        `Unsupported archive format ".${archiveExtension}". Supported: ${supportedExtensions
          .map((ext) => `.${ext}`)
          .join(', ')}.`
      );
    }

    const parentRelativePath = normalizeRelativePath(
      path.posix.dirname(resolved.relativePath || '')
    );
    const {
      allowed: parentAllowed,
      accessInfo: parentAccessInfo,
      resolved: parentResolved,
    } = await authorizeAndResolve(context, parentRelativePath, ACTIONS.createFolder);
    if (!parentAllowed || !parentResolved) {
      throw new ForbiddenError(parentAccessInfo?.denialReason || 'Destination is read-only.');
    }

    const { allowed: filesAllowed, accessInfo: filesAccessInfo } = await authorizeAndResolve(
      context,
      parentRelativePath,
      ACTIONS.write
    );
    if (!filesAllowed) {
      throw new ForbiddenError(filesAccessInfo?.denialReason || 'Destination is read-only.');
    }

    const parentAbsolutePath = parentResolved?.absolutePath;
    if (!parentAbsolutePath) throw new ForbiddenError('Cannot resolve destination folder.');

    const parentStats = await fs.stat(parentAbsolutePath);
    if (!parentStats.isDirectory()) throw new ValidationError('Destination must be a directory.');

    const baseFolderName = (() => {
      try {
        return ensureValidName(archiveBaseName(path.basename(zipAbsolutePath)));
      } catch (_) {
        return 'Archive';
      }
    })();

    // Always extracted into a hidden folder of its own first. Into a new folder,
    // the whole folder is then put under the first name nothing holds, "sample
    // 2" when "sample" is taken, by a move that never replaces or merges into
    // anything. It used to be created under its name before the extraction:
    // what someone put in it meanwhile was then removed with it when the
    // extraction failed, or at the next start after a crash.
    const stagingAbsolutePath = await fs.mkdtemp(
      path.join(parentAbsolutePath, '.nextexplorer-extract-')
    );
    const movedPaths = [];
    // Released however the extraction ends: a stop half-way leaves the record,
    // and the next start removes the hidden folder it names, and only that.
    const inFlight = trackInFlight(stagingAbsolutePath, 'staging-directory');

    // Everything above throws BEFORE any byte is written, so validation errors
    // still surface as normal HTTP errors. From here on the response streams
    // NDJSON progress events, mirroring the copy/move endpoints:
    //   {type:'start',    name}
    //   {type:'progress', percent}    (throttled)
    //   {type:'done',     success, item}
    //   {type:'error',    message, code}
    const writeEvent = startNdjsonStream(res);

    // The name asked for: the one taken, "sample 2" when held, is in `done`.
    writeEvent({ type: 'start', name: baseFolderName });

    const onPercent = throttlePercent(writeEvent);

    try {
      if (await isSevenZipAvailable()) {
        // Listing first means an archive that would expand beyond the limits
        // is refused before anything is written to disk.
        // Cheap pre-flight when the archive declares a usable listing...
        const footprint = await readArchiveFootprint(zipAbsolutePath);
        if (footprint) ensureArchiveWithinLimits(footprint);
        // 7-Zip streams to disk, so large archives don't get buffered in RAM.
        // ...and a running guard for everything else: encrypted archives,
        // listings too large to parse, and the second pass of tarballs.
        await extractArchive(zipAbsolutePath, stagingAbsolutePath, onPercent, {
          signal: controller.signal,
          password: archivePassword,
          maxBytes: archives.maxExtractedBytes,
        });
      } else {
        const fallbackZip = new AdmZip(zipAbsolutePath);
        ensureArchiveWithinLimits(admZipFootprint(fallbackZip.getEntries()));
        fallbackZip.extractAllTo(stagingAbsolutePath, true);
        if (controller.signal.aborted) {
          const error = new Error('Operation cancelled.');
          error.code = 'OPERATION_CANCELLED';
          throw error;
        }
      }

      if (destination === 'folder') {
        // Whole: the hidden folder becomes the new one, under a name nothing
        // holds, named as a new folder is.
        const placed = await placeWithoutOverwrite(
          stagingAbsolutePath,
          parentAbsolutePath,
          baseFolderName,
          { style: 'folder' }
        );

        const item = await buildItemMetadata(placed.path, parentRelativePath, placed.name);
        writeEvent({ type: 'done', success: true, item, items: [item] });
      } else {
        // Extract to a private sibling first, then move each root entry into the
        // current folder. This avoids partial writes and lets us apply the same
        // collision rule used everywhere else: name, name (1), name (2), ...
        const items = await extractIntoCurrentFolder({
          stagingDirectory: stagingAbsolutePath,
          destinationDirectory: parentAbsolutePath,
          relativeParentPath: parentRelativePath,
          movedPaths,
        });
        await fs.rm(stagingAbsolutePath, { recursive: true, force: true });
        writeEvent({
          type: 'done',
          success: true,
          item: items.length === 1 ? items[0] : null,
          items,
        });
      }
    } catch (error) {
      const isPasswordError =
        error?.code === 'ARCHIVE_PASSWORD_REQUIRED' || error?.code === 'ARCHIVE_INVALID_PASSWORD';
      if (isPasswordError) {
        logger.info({ zipAbsolutePath, code: error.code }, 'Archive password required or rejected');
      } else {
        logger.warn(
          { zipAbsolutePath, err: error },
          'Archive extract failed; cleaning up destination'
        );
      }
      // The hidden folder only: a new folder is put under its name once whole,
      // so a failure never has one of its own to remove.
      await fs.rm(stagingAbsolutePath, { recursive: true, force: true });
      // What the extraction placed, and only that: a file someone saved into a
      // placed folder meanwhile stays, with the folders holding it.
      await mapWithConcurrency(movedPaths, (moved) =>
        removeInventoried(moved.path, moved.inventory)
      );
      writeEvent({
        type: 'error',
        message: error.message || 'Archive extraction failed.',
        code: error.code || 'EXTRACT_FAILED',
      });
    } finally {
      inFlight.release();
      req.off('aborted', abort);
      res.off('close', onClose);
      res.end();
    }
  })
);

router.post(
  '/files/zip/compress',
  asyncHandler(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    const { items = [], destination = '', name } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('At least one item is required.');
    }

    const normalizedDestination = normalizeRelativePath(destination || items[0]?.path || '');

    if (!normalizedDestination.trim()) {
      throw new ValidationError(
        'Cannot create archives in the root path. Please select a specific volume or folder first.'
      );
    }

    const context = { user: req.user, guestSession: req.guestSession };
    const {
      allowed: destAllowed,
      accessInfo: destAccess,
      resolved: destResolved,
    } = await authorizeAndResolve(context, normalizedDestination, ACTIONS.write);
    if (!destAllowed || !destResolved) {
      throw new ForbiddenError(destAccess?.denialReason || 'Destination is read-only.');
    }

    const destinationAbsolutePath = destResolved.absolutePath;
    const destStats = await fs.stat(destinationAbsolutePath);
    if (!destStats.isDirectory()) throw new ValidationError('Destination must be a directory.');

    // The list came in the request; the number of checks in flight is ours.
    const sourceTargets = await mapWithConcurrency(items, async (item) => {
      if (!item || typeof item.name !== 'string') {
        throw new ValidationError('Each item must include a name.');
      }
      const itemParent = normalizeRelativePath(item.path || '');
      const itemRelative = combineRelativePath(itemParent, item.name);
      const { allowed, accessInfo, resolved } = await authorizeAndResolve(
        context,
        itemRelative,
        ACTIONS.read
      );
      if (!allowed || !resolved) {
        throw new ForbiddenError(accessInfo?.denialReason || 'Source item is not accessible.');
      }
      const stats = await fs.stat(resolved.absolutePath);
      return {
        name: item.name,
        absolutePath: resolved.absolutePath,
        logicalPath: resolved.relativePath,
        stats,
      };
    });

    const requestedName = (() => {
      if (typeof name === 'string' && name.trim()) {
        const cleaned = ensureValidName(name.trim());
        return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`;
      }
      return defaultZipNameForItems(items);
    })();

    // The archive is written under a hidden name of its own, and only put under
    // the name it is meant to have once it is whole, by a move that never
    // replaces anything. Writing under that name from the start meant a file
    // arriving there during a long compression was overwritten — or, 7-Zip
    // adding to a zip it finds, changed —, and removed if the compression then
    // failed. The name ends in ".zip" so 7-Zip takes it as given.
    const temporaryPath = path.join(
      destinationAbsolutePath,
      `.nextexplorer-zip-${crypto.randomUUID()}.zip`
    );
    const inFlight = trackInFlight(temporaryPath, 'partial-archive');

    // Everything above throws BEFORE any byte is written, so validation errors
    // still surface as normal HTTP errors. From here on the response streams
    // NDJSON progress events, mirroring the extract endpoint:
    //   {type:'start',    name}          the name asked for
    //   {type:'progress', percent}       (throttled)
    //   {type:'done',     success, item} the name taken, "Archive (1).zip" when held
    //   {type:'error',    message, code}
    const writeEvent = startNdjsonStream(res);

    writeEvent({ type: 'start', name: requestedName });

    const onPercent = throttlePercent(writeEvent);

    try {
      // What the archive may hold: only what a listing of those folders shows.
      const { entries, excluded, totalBytes } = await collectArchiveEntries(
        context,
        sourceTargets.map(({ name: entryName, absolutePath, logicalPath, stats }) => ({
          absolutePath,
          logicalPath,
          entryName,
          stats,
        }))
      );

      // 7-Zip takes folders whole, so it only writes archives with nothing to
      // leave out; anything else is written from the list, still streamed.
      if (excluded === 0 && (await isSevenZipAvailable())) {
        // 7-Zip streams the archive to disk instead of assembling it in RAM.
        const sourceParent = path.dirname(sourceTargets[0].absolutePath);
        const hasCommonParent = sourceTargets.every(
          ({ absolutePath }) => path.dirname(absolutePath) === sourceParent
        );
        await createZipArchive(
          hasCommonParent
            ? sourceTargets.map(({ name }) => name)
            : sourceTargets.map(({ absolutePath }) => absolutePath),
          temporaryPath,
          onPercent,
          { signal: controller.signal, cwd: hasCommonParent ? sourceParent : undefined }
        );
      } else {
        await writeZipFile(entries, temporaryPath, {
          totalBytes,
          onPercent,
          signal: controller.signal,
        });
      }

      const placed = await placeWithoutOverwrite(
        temporaryPath,
        destinationAbsolutePath,
        requestedName
      );

      const item = await buildItemMetadata(placed.path, normalizedDestination, placed.name);
      writeEvent({ type: 'done', success: true, item });
    } catch (error) {
      logger.warn({ temporaryPath, err: error }, 'Archive creation failed; cleaning up file');
      // Only the hidden archive this compression wrote: whatever holds the name
      // it was meant to take belongs to someone else.
      await fs.rm(temporaryPath, { force: true });
      writeEvent({
        type: 'error',
        message: error.message || 'Archive creation failed.',
        code: error.code || 'COMPRESS_FAILED',
      });
    } finally {
      inFlight.release();
      req.off('aborted', abort);
      res.off('close', onClose);
      res.end();
    }
  })
);

module.exports = router;
