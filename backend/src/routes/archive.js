const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { getSupportedArchiveExtensions } = require('../services/archiveService');
const { browseArchive } = require('../services/archiveBrowseService');
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

module.exports = router;
