const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const AdmZip = require('adm-zip');

const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { pathExists } = require('../utils/fsUtils');
const {
  normalizeRelativePath,
  combineRelativePath,
  ensureValidName,
  findAvailableFolderName,
  findAvailableName,
} = require('../utils/pathUtils');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const {
  getSupportedArchiveExtensions,
  isSevenZipAvailable,
  extractArchive,
  createZipArchive,
  archiveBaseName,
} = require('../services/archiveService');
const folderSizeHooks = require('../services/folderSizeHooks');

const router = express.Router();

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
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      throw new ValidationError('An archive file path is required.');
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
      ACTIONS.createFile
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

    const folderName = await findAvailableFolderName(parentAbsolutePath, baseFolderName);
    const destinationFolderAbsolutePath = path.join(parentAbsolutePath, folderName);

    await fs.mkdir(destinationFolderAbsolutePath);

    // Everything above throws BEFORE any byte is written, so validation errors
    // still surface as normal HTTP errors. From here on the response streams
    // NDJSON progress events, mirroring the copy/move endpoints:
    //   {type:'start',    name}
    //   {type:'progress', percent}    (throttled)
    //   {type:'done',     success, item}
    //   {type:'error',    message, code}
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Disable proxy buffering so progress lines reach the client promptly.
    res.setHeader('X-Accel-Buffering', 'no');

    const writeEvent = (event) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    writeEvent({ type: 'start', name: folderName });

    const PROGRESS_THROTTLE_MS = 150;
    let lastProgressAt = 0;
    let lastPercent = -1;
    const onPercent = (percent) => {
      const now = Date.now();
      if (percent === lastPercent) return;
      if (percent < 100 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      lastPercent = percent;
      writeEvent({ type: 'progress', percent });
    };

    try {
      if (await isSevenZipAvailable()) {
        // 7-Zip streams to disk, so large archives don't get buffered in RAM.
        await extractArchive(zipAbsolutePath, destinationFolderAbsolutePath, onPercent, {
          signal: controller.signal,
        });
      } else {
        new AdmZip(zipAbsolutePath).extractAllTo(destinationFolderAbsolutePath, true);
        if (controller.signal.aborted) {
          const error = new Error('Operation cancelled.');
          error.code = 'OPERATION_CANCELLED';
          throw error;
        }
      }

      // The archive has produced an entire new tree. Index it now rather than
      // waiting for each nested directory to be visited in the UI.
      await folderSizeHooks.onDirectoryTreeCreated(destinationFolderAbsolutePath);

      const item = await buildItemMetadata(
        destinationFolderAbsolutePath,
        parentRelativePath,
        folderName
      );
      writeEvent({ type: 'done', success: true, item });
    } catch (error) {
      logger.warn({ zipAbsolutePath, err: error }, 'Archive extract failed; cleaning up folder');
      await fs.rm(destinationFolderAbsolutePath, { recursive: true, force: true });
      writeEvent({
        type: 'error',
        message: error.message || 'Archive extraction failed.',
        code: error.code || 'EXTRACT_FAILED',
      });
    } finally {
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
    } = await authorizeAndResolve(context, normalizedDestination, ACTIONS.createFile);
    if (!destAllowed || !destResolved) {
      throw new ForbiddenError(destAccess?.denialReason || 'Destination is read-only.');
    }

    const destinationAbsolutePath = destResolved.absolutePath;
    const destStats = await fs.stat(destinationAbsolutePath);
    if (!destStats.isDirectory()) throw new ValidationError('Destination must be a directory.');

    const sourceTargets = await Promise.all(
      items.map(async (item) => {
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
        return { name: item.name, absolutePath: resolved.absolutePath, stats };
      })
    );

    const requestedName = (() => {
      if (typeof name === 'string' && name.trim()) {
        const cleaned = ensureValidName(name.trim());
        return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`;
      }
      return defaultZipNameForItems(items);
    })();

    const zipFileName = await findAvailableName(destinationAbsolutePath, requestedName);
    const zipAbsolutePath = path.join(destinationAbsolutePath, zipFileName);

    // Everything above throws BEFORE any byte is written, so validation errors
    // still surface as normal HTTP errors. From here on the response streams
    // NDJSON progress events, mirroring the extract endpoint:
    //   {type:'start',    name}
    //   {type:'progress', percent}    (throttled)
    //   {type:'done',     success, item}
    //   {type:'error',    message, code}
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Disable proxy buffering so progress lines reach the client promptly.
    res.setHeader('X-Accel-Buffering', 'no');

    const writeEvent = (event) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    writeEvent({ type: 'start', name: zipFileName });

    const PROGRESS_THROTTLE_MS = 150;
    let lastProgressAt = 0;
    let lastPercent = -1;
    const onPercent = (percent) => {
      const now = Date.now();
      if (percent === lastPercent) return;
      if (percent < 100 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      lastPercent = percent;
      writeEvent({ type: 'progress', percent });
    };

    try {
      if (await isSevenZipAvailable()) {
        // 7-Zip streams the archive to disk instead of assembling it in RAM.
        await createZipArchive(
          sourceTargets.map(({ absolutePath }) => absolutePath),
          zipAbsolutePath,
          onPercent,
          { signal: controller.signal }
        );
      } else {
        const zip = new AdmZip();
        sourceTargets.forEach(({ name: entryName, absolutePath, stats }) => {
          stats.isDirectory()
            ? zip.addLocalFolder(absolutePath, entryName)
            : zip.addLocalFile(absolutePath, '', entryName);
        });
        zip.writeZip(zipAbsolutePath);
        if (controller.signal.aborted) {
          const error = new Error('Operation cancelled.');
          error.code = 'OPERATION_CANCELLED';
          throw error;
        }
      }

      const zipStats = await fs.stat(zipAbsolutePath);
      await folderSizeHooks.onFileWritten(zipAbsolutePath, zipStats.size);

      const item = await buildItemMetadata(zipAbsolutePath, normalizedDestination, zipFileName);
      writeEvent({ type: 'done', success: true, item });
    } catch (error) {
      logger.warn({ zipAbsolutePath, err: error }, 'Archive creation failed; cleaning up file');
      await fs.rm(zipAbsolutePath, { force: true });
      writeEvent({
        type: 'error',
        message: error.message || 'Archive creation failed.',
        code: error.code || 'COMPRESS_FAILED',
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      res.end();
    }
  })
);

module.exports = router;
