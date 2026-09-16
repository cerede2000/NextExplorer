const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const ffmpegRunner = require('../services/ffmpegRunner');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { readExifDetails } = require('../utils/exifDetails');
const { extensions } = require('../config/index');
const { resolvePathWithAccess } = require('../services/accessManager');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');

const router = express.Router();

const probeVideo = async (filePath) => {
  const data = await ffmpegRunner.probe(filePath);
  if (!data) return null;
  const stream = (data.streams || []).find((s) => s.width && s.height) || {};
  return {
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
    duration: Number(data.format?.duration) || null,
  };
};

const sumDirectory = async (dirPath, limit = 200000) => {
  const stack = [dirPath];
  let totalSize = 0;
  let fileCount = 0;
  let dirCount = 0;
  let visited = 0;

  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > limit) {
      break;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          dirCount += 1;
          stack.push(full);
        } else if (stat.isFile()) {
          fileCount += 1;
          totalSize += stat.size;
        }
      } catch (_) {
        // skip unreadable entries
      }
    }
  }

  return { totalSize, fileCount, dirCount, truncated: visited > limit };
};

/**
 * What a picture says about itself.
 *
 * Two readings, asked separately and both allowed to fail: a file that cannot
 * be read as an image still has a name, a size and a date, which is what
 * somebody looking at a damaged file most needs. Losing the whole answer over
 * a broken header would be the wrong trade.
 *
 * One read of the file covers both, because sharp hands back the EXIF block
 * along with the dimensions it was opened for.
 */
const readImageDetails = async (absolutePath, extension) => {
  const details = {};
  let metadata = null;

  try {
    metadata = await sharp(absolutePath).metadata();
    details.width = metadata.width || null;
    details.height = metadata.height || null;
    details.orientation = metadata.orientation || null;
  } catch (e) {
    logger.debug({ err: e }, 'sharp.metadata failed');
  }

  try {
    const exif = await readExifDetails(absolutePath, metadata, extension);
    if (exif) Object.assign(details, exif);
  } catch (e) {
    logger.debug({ err: e }, 'EXIF parse failed');
  }

  return Object.keys(details).length > 0 ? details : null;
};

/** What the filesystem alone knows about a path. */
const describeEntry = (logicalPath, stats) => {
  const extension = path.extname(logicalPath).slice(1).toLowerCase();

  return {
    path: logicalPath,
    name: path.basename(logicalPath),
    kind: stats.isDirectory() ? 'directory' : extension || 'unknown',
    size: stats.size,
    dateModified: stats.mtime,
    dateCreated: stats.birthtime,
  };
};

/** The file's own details, when its kind has any to give. */
const readKindDetails = async (absolutePath, extension) => {
  if (extensions.images.includes(extension)) {
    const image = await readImageDetails(absolutePath, extension);
    return image ? { image } : {};
  }

  if (extensions.videos.includes(extension)) {
    const video = await probeVideo(absolutePath);
    return video ? { video } : {};
  }

  return {};
};

router.get(
  '/metadata/{*splat}',
  asyncHandler(async (req, res) => {
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
      throw new NotFoundError('Path not found.');
    }

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      // For metadata, treat denied access as forbidden (explicit signal to caller)
      throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
    }

    const { absolutePath, relativePath: logicalPath } = resolved;

    // Resolving a path does not require it to exist, so this is where a file
    // that has just been deleted is discovered. Left unhandled it left the
    // details panel answering 500 for the ordinary case of asking about
    // something that is gone.
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Path not found.');
      }
      throw error;
    }

    const base = describeEntry(logicalPath, stats);

    if (stats.isDirectory()) {
      return res.json({ ...base, directory: await sumDirectory(absolutePath) });
    }

    return res.json({ ...base, ...(await readKindDetails(absolutePath, base.kind)) });
  })
);

module.exports = router;
