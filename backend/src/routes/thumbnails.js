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

/**
 * An address in this answer, as the browser will have to ask for it.
 *
 * A visitor who asked under a share's prefix is answered under it, so that
 * everything their browser fetches stays inside the one hole an authentication
 * proxy has to open for a public link. Both of the addresses this route hands
 * out go through here: the thumbnail under `/static/`, and — for an image whose
 * thumbnail could not be made — the file itself at `/api/preview`. Keyed on the
 * scope the gate in front established rather than on how the caller spelled the
 * path, so one answer cannot be prefixed and the other not.
 */
const reachable = (req, url) => {
  if (!req.shareScope || typeof url !== 'string') return url;
  const prefix = `/api/share/${encodeURIComponent(req.shareScope.token)}`;
  if (url.startsWith('/static/')) return `${prefix}${url}`;
  if (url.startsWith('/api/')) return `${prefix}${url.slice('/api'.length)}`;
  return url;
};

/**
 * Where the thumbnail this request just cleared is fetched from. Signed either
 * way — the signature is what unlocks the file — and reachable where it was
 * asked for.
 */
const served = (req, url) => reachable(req, withThumbnailToken(url));

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
    } catch (_) {
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
        return res.json({ thumbnail: served(req, cachedThumbnail), pending: false });
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
        .json({ ...result, thumbnail: served(req, result.thumbnail) });
    } catch (error) {
      logger.warn(
        { absolutePath, err: error },
        'Thumbnail generation scheduling failed, falling back to original file'
      );
    }

    // If thumbnail scheduling failed unexpectedly, fall back to the original file
    // for images — at the address this file is reachable at, which inside a share
    // is the share's own. Handed `/api/preview` instead, the listing of a share
    // behind an authentication proxy drew a broken image for every one of them.
    if (extensions.images.includes(extension) || (extensions.rawImages || []).includes(extension)) {
      const previewUrl = `${reachable(req, '/api/preview')}?path=${encodeURIComponent(logicalPath)}`;
      return res.json({ thumbnail: previewUrl });
    }

    res.json({ thumbnail: '', pending: false });
  })
);

module.exports = router;
