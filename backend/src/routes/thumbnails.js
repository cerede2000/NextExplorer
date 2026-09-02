const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { extensions } = require('../config/index');
const env = require('../config/env');
const {
  getThumbnailPathIfExists,
  queueThumbnailGeneration,
} = require('../services/thumbnailService');
const { resolvePathWithAccess } = require('../services/accessManager');
const { withThumbnailToken } = require('../utils/thumbnailTokens');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, NotFoundError } = require('../errors/AppError');

const router = express.Router();
const { getSettings } = require('../services/settingsService');

const isThumbnailable = (extension = '') => {
  if (!extension) {
    return false;
  }
  const ext = extension.toLowerCase();
  return (
    extensions.images.includes(ext) ||
    (extensions.rawImages || []).includes(ext) ||
    extensions.videos.includes(ext)
  );
};

router.get(
  '/thumbnails/{*splat}',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const thumbsEnabled =
      env.THUMBNAILS_ENABLED !== false && settings?.thumbnails?.enabled !== false;
    if (!thumbsEnabled) {
      return res.json({ thumbnail: '' });
    }
    const rawPath = (req.params.splat || []).join('/');
    const relativePath = normalizeRelativePath(rawPath);

    if (!relativePath) {
      throw new ValidationError('A file path is required.');
    }

    const context = { user: req.user, guestSession: req.guestSession };
    let accessInfo;
    let resolved;
    try {
      ({ accessInfo, resolved } = await resolvePathWithAccess(context, relativePath));
    } catch (error) {
      throw new NotFoundError('File not found.');
    }

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      throw new NotFoundError(accessInfo?.denialReason || 'File not found.');
    }

    const { absolutePath, relativePath: logicalPath } = resolved;
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new NotFoundError('File not found.');
      }
      throw error;
    }

    if (!stats.isFile()) {
      throw new ValidationError('Thumbnails are only available for files.');
    }

    const extension = path.extname(relativePath).slice(1).toLowerCase();
    if (extension === 'pdf') {
      throw new ValidationError('Thumbnails are not available for PDF files.');
    }

    if (!isThumbnailable(extension)) {
      throw new ValidationError('Thumbnails are not available for this file type.');
    }

    try {
      // The access check above is the only one this thumbnail will get: the
      // file itself is served from /static, outside the auth middleware. The
      // token carries that decision to the static handler.
      const cachedThumbnail = await getThumbnailPathIfExists(absolutePath, stats);
      if (cachedThumbnail) {
        return res.json({ thumbnail: withThumbnailToken(cachedThumbnail), pending: false });
      }

      // A prefetch is deliberately lower priority and is admitted only while
      // no interactive thumbnail work is in progress. Authorization remains
      // identical to a regular thumbnail request.
      const isBackgroundPrefetch = req.query.background === '1';
      const result = await queueThumbnailGeneration(
        absolutePath,
        isBackgroundPrefetch ? { priority: -10, onlyWhenIdle: true } : undefined
      );
      return res
        .status(result.pending ? 202 : 200)
        .json({ ...result, thumbnail: withThumbnailToken(result.thumbnail) });
    } catch (error) {
      logger.warn(
        { absolutePath, err: error },
        'Thumbnail generation scheduling failed, falling back to original file'
      );
    }

    // If thumbnail scheduling failed unexpectedly, fall back to the original file for images.
    if (extensions.images.includes(extension) || (extensions.rawImages || []).includes(extension)) {
      const previewUrl = `/api/preview?path=${encodeURIComponent(logicalPath)}`;
      return res.json({ thumbnail: previewUrl });
    }

    res.json({ thumbnail: '', pending: false });
  })
);

module.exports = router;
