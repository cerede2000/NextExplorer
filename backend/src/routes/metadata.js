const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const ffmpegRunner = require('../services/ffmpegRunner');
let exifr = null;

const { normalizeRelativePath } = require('../utils/pathUtils');
const { extensions } = require('../config/index');
const { resolvePathWithAccess } = require('../services/accessManager');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');

const router = express.Router();

// Optional: try to require exifr only when route is hit
const loadExifr = () => {
  if (exifr) return exifr;
  try {
    // eslint-disable-next-line global-require
    exifr = require('exifr');
  } catch (e) {
    exifr = null;
  }
  return exifr;
};

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
 * Two libraries, asked separately and both allowed to fail: a file that cannot
 * be read as an image still has a name, a size and a date, which is what
 * somebody looking at a damaged file most needs. Losing the whole answer over
 * a broken header would be the wrong trade.
 */
const readImageDetails = async (absolutePath) => {
  const details = {};

  try {
    const meta = await sharp(absolutePath).metadata();
    details.width = meta.width || null;
    details.height = meta.height || null;
    details.orientation = meta.orientation || null;
  } catch (e) {
    logger.debug({ err: e }, 'sharp.metadata failed');
  }

  try {
    const exif = loadExifr()
      ? await exifr.parse(absolutePath, {
          tiff: true,
          ifd0: true,
          exif: true,
          gps: true,
          iptc: true,
        })
      : null;
    if (exif) Object.assign(details, readExifFields(exif), { gps: readCoordinates(exif) });
  } catch (e) {
    logger.debug({ err: e }, 'EXIF parse failed');
  }

  return Object.keys(details).length > 0 ? details : null;
};

/**
 * What each detail is called in an EXIF block, in the order to look.
 *
 * Cameras disagree about capitalisation and about which date they write, so
 * every field is several names — a table rather than a chain of `||`, which is
 * what it plainly is and what makes adding a camera's spelling a one-line
 * change.
 */
const EXIF_FIELDS = {
  cameraMake: ['Make', 'make'],
  cameraModel: ['Model', 'model'],
  lensModel: ['LensModel', 'lensModel'],
  software: ['Software'],
  dateTaken: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'],
};

const readExifFields = (exif) =>
  Object.fromEntries(
    Object.entries(EXIF_FIELDS).map(([name, candidates]) => [
      name,
      candidates.map((candidate) => exif[candidate]).find(Boolean) ?? null,
    ])
  );

/** Where a photograph was taken, under whichever pair of names it was stored. */
const readCoordinates = (exif) => {
  if (exif.latitude && exif.longitude) return { lat: exif.latitude, lon: exif.longitude };
  if (exif.GPSLatitude && exif.GPSLongitude) {
    return { lat: exif.GPSLatitude, lon: exif.GPSLongitude };
  }
  return null;
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
    const image = await readImageDetails(absolutePath);
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
