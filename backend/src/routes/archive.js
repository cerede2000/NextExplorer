const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { getSupportedArchiveExtensions } = require('../services/archiveService');
const {
  browseArchive,
  findArchiveEntry,
  openArchiveEntry,
} = require('../services/archiveBrowseService');
const { toExtension, resolveMimeType } = require('../utils/fileTypes');
const { encodeContentDisposition } = require('./files/utils');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');

const router = express.Router();

/**
 * Looking inside an archive, without unpacking it.
 *
 * The address of the archive is a real path on disk, and the position inside
 * it is a separate parameter. Not one virtual path like
 * `/Work/pack.zip/inner/file`: twenty-six files resolve a path and every one
 * of them takes what comes back for a real file — renaming, deleting,
 * uploading, thumbnails, shares, folder sizes, the search index. Teaching all
 * of them a second kind of path is where the holes would be. Here the archive
 * goes through the same resolution as any other file, and what is inside it
 * never leaves this route.
 */

/** The archive named by the request, once the caller is allowed to read it. */
const resolveArchive = async (req) => {
  const relativePath = normalizeRelativePath(
    typeof req.query.path === 'string' ? req.query.path : ''
  );
  if (!relativePath) {
    throw new ValidationError('The path of an archive is required.');
  }

  const context = { user: req.user, guestSession: req.guestSession };
  let accessInfo;
  let resolved;
  try {
    ({ accessInfo, resolved } = await resolvePathWithAccess(context, relativePath));
  } catch (_) {
    throw new NotFoundError('Path not found.');
  }

  if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
  }

  let stats;
  try {
    stats = await fs.stat(resolved.absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new NotFoundError('Path not found.');
    throw error;
  }
  if (!stats.isFile()) {
    throw new ValidationError('That is not an archive.');
  }

  // Only what this build of 7-Zip can actually read, and only what the
  // configuration offers as an archive: the same list extraction is held to,
  // so nothing is browsable that could not then be extracted.
  const extension = path.extname(resolved.relativePath).slice(1).toLowerCase();
  const supported = await getSupportedArchiveExtensions();
  if (!supported.includes(extension)) {
    throw new ValidationError('That kind of file cannot be opened as an archive.');
  }

  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
};

router.get(
  '/archive/list',
  asyncHandler(async (req, res) => {
    const archive = await resolveArchive(req);
    const inside = typeof req.query.inside === 'string' ? req.query.inside : '';

    const listing = await browseArchive(archive.absolutePath, inside);

    return res.json({
      path: archive.relativePath,
      name: path.basename(archive.relativePath),
      ...listing,
    });
  })
);

/**
 * One file out of an archive, without unpacking the rest of it.
 *
 * Always as an attachment. A file inside somebody's archive is somebody else's
 * HTML as easily as their photograph, and served inline it would run on this
 * application's origin: that is a decision about previewing, not about reading,
 * and it is not made here. The type is still declared, so a saved file arrives
 * named and typed as what it is, and `nosniff` stops the browser arguing.
 */
router.get(
  '/archive/entry',
  asyncHandler(async (req, res) => {
    const archive = await resolveArchive(req);
    const wanted = typeof req.query.entry === 'string' ? req.query.entry : '';
    const entry = await findArchiveEntry(archive.absolutePath, wanted);

    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    res.setHeader('Content-Type', resolveMimeType(toExtension(name)));
    res.setHeader('Content-Disposition', encodeContentDisposition(name, 'attachment'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    // What the archive says the entry weighs, which is what `-so` writes. A
    // damaged archive that writes less ends the download short, which is what
    // it is, rather than looking like a file that arrived whole.
    if (Number.isFinite(entry.size)) res.setHeader('Content-Length', String(entry.size));

    const reading = openArchiveEntry(archive.absolutePath, entry.path);

    // Whoever closed the tab is not waiting for the rest of it, and 7-Zip would
    // otherwise go on decompressing into a pipe nobody reads.
    res.once('close', () => {
      if (!res.writableEnded) reading.stop();
    });

    reading.stdout.pipe(res);

    try {
      await reading.finished;
    } catch (error) {
      reading.stop();
      if (res.headersSent) {
        // The answer was already on its way: there is no status left to send,
        // and ending it short is the only honest thing available.
        logger.warn({ err: error, entry: entry.path }, 'Reading an archive entry stopped short');
        res.destroy();
        return;
      }
      throw error;
    }
  })
);

module.exports = router;
