const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const PQueue = require('p-queue').default;

const { ensureDir } = require('../utils/fsUtils');
const { directories, extensions } = require('../config/index');
const env = require('../config/env');
const { getSettings } = require('../services/settingsService');
const logger = require('../utils/logger');
const { getRawPreviewJpegPath } = require('./rawPreviewService');

const getThumbOptions = async () => {
  const settings = await getSettings();
  const size = Number.isFinite(settings?.thumbnails?.size) ? settings.thumbnails.size : 200;
  const quality = Number.isFinite(settings?.thumbnails?.quality) ? settings.thumbnails.quality : 70;
  return { size, quality };
};

const currentConcurrency = sharp.concurrency();
sharp.concurrency(Math.max(1, Math.min(8, currentConcurrency)));
sharp.cache({ memory: 256, files: 0 });

const EXECUTABLE_CANDIDATES = {
  ffmpeg: [env.FFMPEG_PATH, '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
  ffprobe: [
    env.FFPROBE_PATH,
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
  ],
};

let canProcessVideoThumbnails = false;

const resolveExecutable = (candidates = []) => {
  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      // try next candidate
    }
  }

  return null;
};

const configureFfmpegBinaries = () => {
  const ffmpegPath = resolveExecutable(EXECUTABLE_CANDIDATES.ffmpeg);
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  } else {
    logger.warn('FFmpeg binary not found. Video thumbnails will be skipped.');
  }

  const ffprobePath = resolveExecutable(EXECUTABLE_CANDIDATES.ffprobe);
  if (ffprobePath) {
    ffmpeg.setFfprobePath(ffprobePath);
  } else {
    logger.warn('ffprobe binary not found. Video thumbnails will be skipped.');
  }

  canProcessVideoThumbnails = Boolean(ffmpegPath && ffprobePath);
};

configureFfmpegBinaries();

const isImage = (ext) => extensions.images.includes(ext);
const isRawImage = (ext) => (extensions.rawImages || []).includes(ext);
const isVideo = (ext) => extensions.videos.includes(ext);
const isPdf = (ext) => ext === 'pdf';
const isHeic = (ext) => ext === 'heic';

const inflight = new Map();
const failedThumbnails = new Map();

const THUMBNAIL_CACHE_VERSION = 2;
const QUEUE_CONCURRENCY_REFRESH_INTERVAL_MS = 30 * 1000;
const FAILED_THUMBNAIL_TTL_MS = 10 * 60 * 1000;
const FAILED_THUMBNAIL_MAX_ENTRIES = 1000;
const THUMBNAIL_CACHE_MAX_FILES = Number.isFinite(env.THUMBNAIL_CACHE_MAX_FILES)
  ? Math.max(0, Math.floor(env.THUMBNAIL_CACHE_MAX_FILES))
  : 3000;
const THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS = Number.isFinite(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS)
  ? Math.max(60 * 1000, Math.floor(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS))
  : 60 * 60 * 1000;
const THUMBNAIL_CACHE_TARGET_RATIO = 0.9;

// Create thumbnail generation queue with concurrency limit
// This prevents overwhelming the system with too many concurrent sharp/ffmpeg operations
// Concurrency is dynamically updated from settings
const thumbnailQueue = new PQueue({
  concurrency: 10, // Default: 10 concurrent thumbnail generations (updated from settings)
  timeout: 30000, // 30 second timeout per thumbnail
  throwOnTimeout: false,
});

let queueConcurrencyRefreshPromise = null;
let lastQueueConcurrencyRefreshAt = 0;
let lastQueueConcurrency = thumbnailQueue.concurrency;
let thumbnailCacheCleanupPromise = null;
let thumbnailCacheCleanupTimer = null;
let lastThumbnailCacheCleanupAt = 0;

// Update queue concurrency from settings
const updateQueueConcurrency = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && now - lastQueueConcurrencyRefreshAt < QUEUE_CONCURRENCY_REFRESH_INTERVAL_MS) {
    return;
  }

  if (queueConcurrencyRefreshPromise) {
    return queueConcurrencyRefreshPromise;
  }

  queueConcurrencyRefreshPromise = (async () => {
    lastQueueConcurrencyRefreshAt = Date.now();

    try {
      const settings = await getSettings();
      const rawConcurrency = Number(settings?.thumbnails?.concurrency) || 10;
      const concurrency = Math.max(1, Math.min(50, Math.floor(rawConcurrency)));

      if (concurrency !== lastQueueConcurrency) {
        thumbnailQueue.concurrency = concurrency;
        lastQueueConcurrency = concurrency;
        logger.info({ concurrency }, 'Thumbnail queue concurrency set');
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to update thumbnail queue concurrency');
    } finally {
      queueConcurrencyRefreshPromise = null;
    }
  })();

  return queueConcurrencyRefreshPromise;
};

// Initialize concurrency from settings
updateQueueConcurrency({ force: true });

// Log queue stats periodically for monitoring
thumbnailQueue.on('active', () => {
  logger.debug(
    {
      size: thumbnailQueue.size,
      pending: thumbnailQueue.pending,
      concurrency: thumbnailQueue.concurrency,
    },
    'Thumbnail queue status'
  );
});

const hashForFile = async (filePath, stats = null) => {
  const info = stats || (await fsPromises.stat(filePath));
  const hash = crypto.createHash('sha1');
  hash.update(filePath);
  hash.update(String(info.size));
  hash.update(String(Math.floor(info.mtimeMs)));
  return hash.digest('hex');
};

const atomicWrite = async (finalPath, buffer) => {
  await ensureDir(path.dirname(finalPath));
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(tmpPath, buffer);
  await fsPromises.rename(tmpPath, finalPath);
};

const makeImageThumb = async (srcPath, destPath) => {
  const { size, quality } = await getThumbOptions();
  const buffer = await sharp(srcPath)
    .rotate()
    .resize({
      width: size,
      height: size,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })
    .webp({ quality, effort: 4 })
    .toBuffer();

  await atomicWrite(destPath, buffer);
};

const makeRawImageThumb = async (srcPath, destPath) => {
  const previewJpegPath = await getRawPreviewJpegPath(srcPath);
  await makeImageThumb(previewJpegPath, destPath);
};

const probeDuration = (filePath) =>
  new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (error, data) => {
      if (error || !data?.format?.duration) {
        resolve(null);
        return;
      }

      resolve(Number(data.format.duration) || null);
    });
  });

const makeVideoThumb = async (srcPath, destPath) => {
  if (!canProcessVideoThumbnails) {
    logger.warn({ srcPath }, 'Skipping video thumbnail (no ffmpeg/ffprobe)');
    return;
  }

  const duration = await probeDuration(srcPath);
  const seconds =
    duration && Number.isFinite(duration) ? Math.max(1, Math.floor(duration * 0.05)) : 1;

  await new Promise((resolve, reject) => {
    // Size is dynamic; capture inside ffmpeg filter
    let size = 200;
    getThumbOptions()
      .then(({ size: sz }) => {
        size = sz;
      })
      .catch(() => {});
    const inputOptions = ['-hide_banner', '-loglevel', 'error'];

    if (env.FFMPEG_HWACCEL) {
      inputOptions.push('-hwaccel', env.FFMPEG_HWACCEL);
    }

    if (env.FFMPEG_HWACCEL_DEVICE) {
      inputOptions.push('-hwaccel_device', env.FFMPEG_HWACCEL_DEVICE);
    }

    if (env.FFMPEG_HWACCEL_OUTPUT_FORMAT) {
      inputOptions.push('-hwaccel_output_format', env.FFMPEG_HWACCEL_OUTPUT_FORMAT);
    }

    const command = ffmpeg(srcPath)
      .inputOptions(inputOptions)
      .seekInput(seconds)
      .outputOptions(['-frames:v', '1', '-vf', `scale=${size}:-1:flags=lanczos`, '-vcodec', 'png'])
      .format('image2pipe')
      .on('error', reject);

    const stream = command.pipe();
    stream.on('error', reject);

    (async () => {
      const { quality } = await getThumbOptions();
      const pipeline = sharp().webp({ quality, effort: 4 });
      stream.pipe(pipeline);
      pipeline
        .toBuffer()
        .then((buffer) => atomicWrite(destPath, buffer))
        .then(resolve)
        .catch(reject);
    })().catch(reject);
  });
};

const makeHeicThumb = async (srcPath, destPath) => {
  const { size, quality } = await getThumbOptions();

  await new Promise((resolve, reject) => {
    // Use ImageMagick to convert HEIC to PNG, then pipe to sharp for WebP conversion
    const convert = spawn('convert', [
      srcPath,
      '-auto-orient',
      '-resize',
      `${size}x`,
      '-quality',
      '100',
      'png:-',
    ]);

    let stderr = '';
    convert.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    convert.on('error', (err) => {
      reject(new Error(`Failed to spawn ImageMagick convert: ${err.message}`));
    });

    convert.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ImageMagick convert exited with code ${code}: ${stderr}`));
      }
    });

    const pipeline = sharp().webp({ quality, effort: 4 });
    convert.stdout.pipe(pipeline);

    pipeline
      .toBuffer()
      .then((buffer) => atomicWrite(destPath, buffer))
      .then(resolve)
      .catch(reject);
  });
};

const generateThumbnail = async (filePath, thumbPath) => {
  const extension = path.extname(filePath).toLowerCase().slice(1);

  if (isPdf(extension)) {
    return;
  }

  if (isHeic(extension)) {
    await makeHeicThumb(filePath, thumbPath);
    return;
  }

  if (isRawImage(extension)) {
    await makeRawImageThumb(filePath, thumbPath);
    return;
  }

  if (isImage(extension)) {
    await makeImageThumb(filePath, thumbPath);
    return;
  }

  if (isVideo(extension)) {
    await makeVideoThumb(filePath, thumbPath);
    return;
  }

  throw new Error(`Unsupported file type: .${extension}`);
};

const buildThumbnailPaths = async (filePath, stats = null) => {
  const key = await hashForFile(filePath, stats);
  const thumbFile = `v${THUMBNAIL_CACHE_VERSION}-${key}.webp`;
  const thumbPath = path.join(directories.thumbnails, thumbFile);
  return { thumbFile, thumbPath };
};

const getFailedThumbnail = (thumbPath) => {
  const failedAt = failedThumbnails.get(thumbPath);
  if (!failedAt) {
    return false;
  }

  if (Date.now() - failedAt > FAILED_THUMBNAIL_TTL_MS) {
    failedThumbnails.delete(thumbPath);
    return false;
  }

  return true;
};

const markFailedThumbnail = (thumbPath) => {
  if (failedThumbnails.size >= FAILED_THUMBNAIL_MAX_ENTRIES) {
    const oldestKey = failedThumbnails.keys().next().value;
    if (oldestKey) {
      failedThumbnails.delete(oldestKey);
    }
  }

  failedThumbnails.set(thumbPath, Date.now());
};

const cleanupThumbnailCache = async () => {
  if (THUMBNAIL_CACHE_MAX_FILES <= 0) {
    return;
  }

  if (thumbnailCacheCleanupPromise) {
    return thumbnailCacheCleanupPromise;
  }

  thumbnailCacheCleanupPromise = (async () => {
    lastThumbnailCacheCleanupAt = Date.now();

    try {
      await ensureDir(directories.thumbnails);
      const dirents = await fsPromises.readdir(directories.thumbnails, { withFileTypes: true });
      const fileNames = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);

      if (fileNames.length <= THUMBNAIL_CACHE_MAX_FILES) {
        return;
      }

      const files = [];
      for (const name of fileNames) {
        const filePath = path.join(directories.thumbnails, name);
        try {
          const stats = await fsPromises.stat(filePath);
          files.push({ filePath, mtimeMs: stats.mtimeMs });
        } catch (_) {
          // File may have been removed by another request.
        }
      }

      if (files.length <= THUMBNAIL_CACHE_MAX_FILES) {
        return;
      }

      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const targetCount = Math.max(
        0,
        Math.floor(THUMBNAIL_CACHE_MAX_FILES * THUMBNAIL_CACHE_TARGET_RATIO)
      );
      const deleteCount = Math.max(0, files.length - targetCount);
      const toDelete = files.slice(0, deleteCount);

      let deleted = 0;
      for (const file of toDelete) {
        try {
          await fsPromises.rm(file.filePath, { force: true });
          deleted += 1;
        } catch (_) {
          // Best-effort cache cleanup.
        }
      }

      logger.info(
        {
          deleted,
          before: files.length,
          target: targetCount,
          max: THUMBNAIL_CACHE_MAX_FILES,
        },
        'Thumbnail cache cleanup completed'
      );
    } catch (error) {
      logger.warn({ err: error }, 'Thumbnail cache cleanup failed');
    } finally {
      thumbnailCacheCleanupPromise = null;
    }
  })();

  return thumbnailCacheCleanupPromise;
};

const scheduleThumbnailCacheCleanup = ({ force = false, delayMs = 5000 } = {}) => {
  if (THUMBNAIL_CACHE_MAX_FILES <= 0) {
    return;
  }

  const now = Date.now();
  if (!force && now - lastThumbnailCacheCleanupAt < THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS) {
    return;
  }

  if (thumbnailCacheCleanupTimer || thumbnailCacheCleanupPromise) {
    return;
  }

  thumbnailCacheCleanupTimer = setTimeout(() => {
    thumbnailCacheCleanupTimer = null;
    cleanupThumbnailCache().catch(() => {});
  }, delayMs);
  if (typeof thumbnailCacheCleanupTimer.unref === 'function') {
    thumbnailCacheCleanupTimer.unref();
  }
};

scheduleThumbnailCacheCleanup({ force: true, delayMs: 30 * 1000 });

const getThumbnailPathIfExists = async (filePath, stats = null) => {
  if (filePath.includes(directories.thumbnails)) {
    return '';
  }

  const extension = path.extname(filePath).toLowerCase().slice(1);
  if (isPdf(extension)) {
    return '';
  }

  const { thumbFile, thumbPath } = await buildThumbnailPaths(filePath, stats);

  try {
    await fsPromises.access(thumbPath, fs.constants.F_OK);
    return `/static/thumbnails/${thumbFile}`;
  } catch (error) {
    return '';
  }
};

const getThumbnail = async (filePath) => {
  if (filePath.includes(directories.thumbnails)) {
    return '';
  }

  const extension = path.extname(filePath).toLowerCase().slice(1);
  if (isPdf(extension)) {
    return '';
  }

  const { thumbFile, thumbPath } = await buildThumbnailPaths(filePath);

  // Check if thumbnail already exists (fast path)
  try {
    await fsPromises.access(thumbPath, fs.constants.F_OK);
    failedThumbnails.delete(thumbPath);
    return `/static/thumbnails/${thumbFile}`;
  } catch (error) {
    // Thumbnail doesn't exist, need to generate
  }

  if (getFailedThumbnail(thumbPath)) {
    return '';
  }

  // Update queue concurrency from settings (non-blocking)
  updateQueueConcurrency().catch(() => {});

  // Check if generation is already in progress for this file
  let pending = inflight.get(thumbPath);
  if (!pending) {
    // Queue the thumbnail generation with concurrency limit
    pending = thumbnailQueue
      .add(async () => {
        try {
          // Double-check if another request created it while we were queued
          try {
            await fsPromises.access(thumbPath, fs.constants.F_OK);
            return `/static/thumbnails/${thumbFile}`;
          } catch (error) {
            // Still doesn't exist, generate it
          }

          logger.debug({ filePath, thumbPath }, 'Generating thumbnail');
          await generateThumbnail(filePath, thumbPath);
          scheduleThumbnailCacheCleanup();

          // Verify generation succeeded
          try {
            await fsPromises.access(thumbPath, fs.constants.F_OK);
            logger.debug({ filePath, thumbPath }, 'Thumbnail generated successfully');
            return `/static/thumbnails/${thumbFile}`;
          } catch (missing) {
            logger.warn(
              { filePath, thumbPath },
              'Thumbnail generation completed but file not found'
            );
            return '';
          }
        } catch (error) {
          markFailedThumbnail(thumbPath);
          logger.error({ filePath, err: error }, 'Thumbnail generation failed');
          throw error;
        }
      })
      .finally(() => {
        // Clean up inflight map when done
        inflight.delete(thumbPath);
      });

    inflight.set(thumbPath, pending);
  }

  return pending;
};

const queueThumbnailGeneration = (filePath) => {
  if (!filePath || filePath.includes(directories.thumbnails)) {
    return;
  }

  const extension = path.extname(filePath).toLowerCase().slice(1);
  if (isPdf(extension)) {
    return;
  }

  getThumbnail(filePath).catch((error) => {
    logger.warn({ filePath, err: error }, 'Queued thumbnail generation failed');
  });
};

module.exports = {
  generateThumbnail,
  getThumbnail,
  getThumbnailPathIfExists,
  queueThumbnailGeneration,
};
