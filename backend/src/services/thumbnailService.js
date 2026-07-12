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
const SHARP_CACHE_MEMORY_MB = Number.isFinite(env.THUMBNAIL_SHARP_CACHE_MEMORY_MB)
  ? Math.max(0, Math.min(256, Math.floor(env.THUMBNAIL_SHARP_CACHE_MEMORY_MB)))
  : 32;
const configureSharpCache = () => {
  sharp.cache({
    memory: SHARP_CACHE_MEMORY_MB,
    files: 0,
    items: SHARP_CACHE_MEMORY_MB > 0 ? 100 : 0,
  });
};
const trimSharpCache = () => {
  sharp.cache(false);
  configureSharpCache();
};
configureSharpCache();

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

  const ffprobeRequired = env.THUMBNAIL_VIDEO_SEEK_PERCENT != null;
  const ffprobePath = resolveExecutable(EXECUTABLE_CANDIDATES.ffprobe);
  if (ffprobePath) {
    ffmpeg.setFfprobePath(ffprobePath);
  } else if (ffprobeRequired) {
    logger.warn('ffprobe binary not found. Video thumbnails will be skipped.');
  }

  canProcessVideoThumbnails = Boolean(ffmpegPath && (!ffprobeRequired || ffprobePath));
};

configureFfmpegBinaries();

const isImage = (ext) => extensions.images.includes(ext);
const isRawImage = (ext) => (extensions.rawImages || []).includes(ext);
const isVideo = (ext) => extensions.videos.includes(ext);
const isPdf = (ext) => ext === 'pdf';
const isHeic = (ext) => ext === 'heic';

const inflight = new Map();
const failedThumbnails = new Map();

const THUMBNAIL_CACHE_VERSION = 3;
const QUEUE_CONCURRENCY_REFRESH_INTERVAL_MS = 30 * 1000;
const FAILED_THUMBNAIL_TTL_MS = 10 * 60 * 1000;
const FAILED_THUMBNAIL_MAX_ENTRIES = 1000;
const THUMBNAIL_CACHE_MAX_FILES = Number.isFinite(env.THUMBNAIL_CACHE_MAX_FILES)
  ? Math.max(0, Math.floor(env.THUMBNAIL_CACHE_MAX_FILES))
  : 3000;
const THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS = Number.isFinite(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS)
  ? Math.max(60 * 1000, Math.floor(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS))
  : 60 * 60 * 1000;
const THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE = Number.isFinite(env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE)
  ? Math.max(1, Math.floor(env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE))
  : 500;
const THUMBNAIL_VIDEO_CONCURRENCY = Number.isFinite(env.THUMBNAIL_VIDEO_CONCURRENCY)
  ? Math.max(1, Math.min(4, Math.floor(env.THUMBNAIL_VIDEO_CONCURRENCY)))
  : 1;
const THUMBNAIL_VIDEO_SEEK_SECONDS = Number.isFinite(env.THUMBNAIL_VIDEO_SEEK_SECONDS)
  ? Math.max(0, Math.floor(env.THUMBNAIL_VIDEO_SEEK_SECONDS))
  : 5;
const THUMBNAIL_VIDEO_SEEK_PERCENT = Number.isFinite(env.THUMBNAIL_VIDEO_SEEK_PERCENT)
  ? Math.max(0, Math.min(1, Number(env.THUMBNAIL_VIDEO_SEEK_PERCENT)))
  : null;
const THUMBNAIL_VIDEO_THREADS = Number.isFinite(env.THUMBNAIL_VIDEO_THREADS)
  ? Math.max(1, Math.min(8, Math.floor(env.THUMBNAIL_VIDEO_THREADS)))
  : 1;
const THUMBNAIL_VIDEO_SCALE_FLAGS = /^[a-z0-9_+.-]+$/i.test(env.THUMBNAIL_VIDEO_SCALE_FLAGS || '')
  ? env.THUMBNAIL_VIDEO_SCALE_FLAGS
  : 'fast_bilinear';
const THUMBNAIL_DIAGNOSTICS_ENABLED = env.THUMBNAIL_DIAGNOSTICS_ENABLED === true;
const THUMBNAIL_DIAGNOSTICS_INTERVAL_MS = Number.isFinite(env.THUMBNAIL_DIAGNOSTICS_INTERVAL_MS)
  ? Math.max(5000, Math.floor(env.THUMBNAIL_DIAGNOSTICS_INTERVAL_MS))
  : 30000;
const THUMBNAIL_SLOW_JOB_MS = Number.isFinite(env.THUMBNAIL_SLOW_JOB_MS)
  ? Math.max(1000, Math.floor(env.THUMBNAIL_SLOW_JOB_MS))
  : 10000;
const THUMBNAIL_CACHE_CONTINUE_DELAY_MS = 30 * 1000;
const THUMBNAIL_CACHE_DIR = path.resolve(directories.thumbnails);
const THUMBNAIL_CACHE_FILE_PATTERN = /^v\d+-(?:[a-f0-9]{40}|[a-f0-9]{64})\.webp$/i;
const THUMBNAILS_ENABLED = env.THUMBNAILS_ENABLED !== false;
const activeThumbnailJobs = new Map();
const activeExternalProcesses = new Map();
const thumbnailStats = {
  requests: 0,
  cacheHits: 0,
  queued: 0,
  generated: 0,
  failed: 0,
  failedTtlSkips: 0,
  cacheCleanupDeleted: 0,
  ffmpegStarted: 0,
  convertStarted: 0,
};

// Create thumbnail generation queue with concurrency limit
// This prevents overwhelming the system with too many concurrent sharp/ffmpeg operations
// Concurrency is dynamically updated from settings
const thumbnailQueue = new PQueue({
  concurrency: 10, // Default: 10 concurrent thumbnail generations (updated from settings)
  timeout: 30000, // 30 second timeout per thumbnail
  throwOnTimeout: false,
});

const videoThumbnailQueue = new PQueue({
  concurrency: THUMBNAIL_VIDEO_CONCURRENCY,
  timeout: 30000,
  throwOnTimeout: false,
});

let queueConcurrencyRefreshPromise = null;
let lastQueueConcurrencyRefreshAt = 0;
let lastQueueConcurrency = thumbnailQueue.concurrency;
let sharpCacheTrimTimer = null;
let thumbnailCacheCleanupPromise = null;
let thumbnailCacheCleanupTimer = null;
let lastThumbnailCacheCleanupAt = 0;
let thumbnailDiagnosticsTimer = null;

const toMb = (bytes) => Math.round((Number(bytes) || 0) / 1024 / 1024);

const summarizeActiveMap = (map, { now = Date.now(), limit = 5 } = {}) =>
  Array.from(map.values())
    .map((item) => ({
      id: item.id,
      type: item.type,
      ext: item.ext,
      fileName: item.fileName,
      pid: item.pid,
      ageMs: now - item.startedAt,
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, limit);

const countBy = (items, key) =>
  items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});

const safeSharpDiagnostics = () => {
  try {
    return {
      cache: sharp.cache(),
      counters: sharp.counters(),
    };
  } catch (error) {
    return { error: error.message };
  }
};

const getDiagnosticsSnapshot = () => {
  const now = Date.now();
  const memory = process.memoryUsage();
  const activeJobs = Array.from(activeThumbnailJobs.values());
  const activeProcesses = Array.from(activeExternalProcesses.values());

  return {
    memoryMb: {
      rss: toMb(memory.rss),
      heapUsed: toMb(memory.heapUsed),
      heapTotal: toMb(memory.heapTotal),
      external: toMb(memory.external),
      arrayBuffers: toMb(memory.arrayBuffers),
    },
    queues: {
      thumbnail: {
        size: thumbnailQueue.size,
        pending: thumbnailQueue.pending,
        concurrency: thumbnailQueue.concurrency,
      },
      video: {
        size: videoThumbnailQueue.size,
        pending: videoThumbnailQueue.pending,
        concurrency: videoThumbnailQueue.concurrency,
      },
    },
    counts: {
      inflight: inflight.size,
      failedCache: failedThumbnails.size,
      activeJobs: activeJobs.length,
      activeExternalProcesses: activeProcesses.length,
    },
    activeByType: countBy(activeJobs, 'type'),
    activeByExt: countBy(activeJobs, 'ext'),
    activeExternalByType: countBy(activeProcesses, 'type'),
    oldestJobs: summarizeActiveMap(activeThumbnailJobs, { now }),
    oldestExternalProcesses: summarizeActiveMap(activeExternalProcesses, { now }),
    stats: { ...thumbnailStats },
    sharp: safeSharpDiagnostics(),
    cleanup: {
      cacheMaxFiles: THUMBNAIL_CACHE_MAX_FILES,
      cleanupInProgress: Boolean(thumbnailCacheCleanupPromise),
      cleanupTimerScheduled: Boolean(thumbnailCacheCleanupTimer),
      lastCleanupAgeMs: lastThumbnailCacheCleanupAt ? now - lastThumbnailCacheCleanupAt : null,
    },
  };
};

const logThumbnailDiagnostics = (reason, extra = {}) => {
  if (!THUMBNAIL_DIAGNOSTICS_ENABLED) return;
  logger.info({ reason, ...getDiagnosticsSnapshot(), ...extra }, 'Thumbnail diagnostics');
};

const startThumbnailDiagnostics = () => {
  if (!THUMBNAIL_DIAGNOSTICS_ENABLED || thumbnailDiagnosticsTimer) {
    return;
  }

  logger.info(
    {
      intervalMs: THUMBNAIL_DIAGNOSTICS_INTERVAL_MS,
      slowJobMs: THUMBNAIL_SLOW_JOB_MS,
      cacheMaxFiles: THUMBNAIL_CACHE_MAX_FILES,
      sharpCacheMemoryMb: SHARP_CACHE_MEMORY_MB,
      videoConcurrency: THUMBNAIL_VIDEO_CONCURRENCY,
      videoSeekSeconds: THUMBNAIL_VIDEO_SEEK_SECONDS,
      videoSeekPercent: THUMBNAIL_VIDEO_SEEK_PERCENT,
      videoThreads: THUMBNAIL_VIDEO_THREADS,
      videoScaleFlags: THUMBNAIL_VIDEO_SCALE_FLAGS,
    },
    'Thumbnail diagnostics enabled'
  );

  thumbnailDiagnosticsTimer = setInterval(() => {
    logThumbnailDiagnostics('interval');
  }, THUMBNAIL_DIAGNOSTICS_INTERVAL_MS);

  if (typeof thumbnailDiagnosticsTimer.unref === 'function') {
    thumbnailDiagnosticsTimer.unref();
  }
};

const startThumbnailJob = (filePath, thumbPath) => {
  const id = crypto.randomUUID();
  const ext = path.extname(filePath).toLowerCase().slice(1) || 'unknown';
  const type = isVideo(ext)
    ? 'video'
    : isHeic(ext)
      ? 'heic'
      : isRawImage(ext)
        ? 'raw'
        : isImage(ext)
          ? 'image'
          : ext;
  const job = {
    id,
    type,
    ext,
    fileName: path.basename(filePath),
    thumbFile: path.basename(thumbPath),
    startedAt: Date.now(),
  };

  activeThumbnailJobs.set(id, job);
  if (THUMBNAIL_DIAGNOSTICS_ENABLED) {
    logger.info({ job, queues: getDiagnosticsSnapshot().queues }, 'Thumbnail job started');
  }
  return id;
};

const finishThumbnailJob = (id, status, error = null) => {
  const job = activeThumbnailJobs.get(id);
  if (!job) return;

  activeThumbnailJobs.delete(id);
  const durationMs = Date.now() - job.startedAt;
  const payload = {
    job,
    status,
    durationMs,
    memoryMb: getDiagnosticsSnapshot().memoryMb,
    error: error ? error.message : undefined,
  };

  if (THUMBNAIL_DIAGNOSTICS_ENABLED || durationMs >= THUMBNAIL_SLOW_JOB_MS) {
    logger.info(payload, 'Thumbnail job finished');
  }
};

const registerExternalProcess = (type, filePath, pid, extra = {}) => {
  const id = crypto.randomUUID();
  const item = {
    id,
    type,
    ext: path.extname(filePath).toLowerCase().slice(1) || 'unknown',
    fileName: path.basename(filePath),
    pid: pid || null,
    startedAt: Date.now(),
    ...extra,
  };

  activeExternalProcesses.set(id, item);
  if (type === 'ffmpeg') thumbnailStats.ffmpegStarted += 1;
  if (type === 'convert') thumbnailStats.convertStarted += 1;

  if (THUMBNAIL_DIAGNOSTICS_ENABLED) {
    logger.info(
      { process: item, memoryMb: getDiagnosticsSnapshot().memoryMb },
      'Thumbnail external process started'
    );
  }

  return id;
};

const unregisterExternalProcess = (id, status, error = null) => {
  if (!id) return;
  const item = activeExternalProcesses.get(id);
  if (!item) return;

  activeExternalProcesses.delete(id);
  const durationMs = Date.now() - item.startedAt;
  if (THUMBNAIL_DIAGNOSTICS_ENABLED || durationMs >= THUMBNAIL_SLOW_JOB_MS) {
    logger.info(
      {
        process: item,
        status,
        durationMs,
        error: error ? error.message : undefined,
        memoryMb: getDiagnosticsSnapshot().memoryMb,
      },
      'Thumbnail external process finished'
    );
  }
};

startThumbnailDiagnostics();

const scheduleSharpCacheTrim = ({ delayMs = 2 * 1000 } = {}) => {
  if (sharpCacheTrimTimer) {
    clearTimeout(sharpCacheTrimTimer);
  }

  sharpCacheTrimTimer = setTimeout(() => {
    sharpCacheTrimTimer = null;
    if (thumbnailQueue.size === 0 && thumbnailQueue.pending === 0) {
      trimSharpCache();
      logger.debug({ memoryMb: SHARP_CACHE_MEMORY_MB }, 'Sharp thumbnail cache trimmed');
      return;
    }

    scheduleSharpCacheTrim({ delayMs });
  }, delayMs);

  if (typeof sharpCacheTrimTimer.unref === 'function') {
    sharpCacheTrimTimer.unref();
  }
};

const isInsideDirectory = (candidatePath, directoryPath) => {
  if (!candidatePath) {
    return false;
  }

  const relativePath = path.relative(directoryPath, path.resolve(candidatePath));
  return (
    relativePath === '' ||
    (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
};

const isThumbnailCachePath = (filePath) => {
  if (!filePath) {
    return false;
  }

  return (
    isInsideDirectory(filePath, THUMBNAIL_CACHE_DIR) ||
    THUMBNAIL_CACHE_FILE_PATTERN.test(path.basename(filePath))
  );
};

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

const resolveThumbnailSourceIdentity = async (filePath) => {
  try {
    return await fsPromises.realpath(filePath);
  } catch (_) {
    return path.resolve(filePath);
  }
};

const hashForFile = async (filePath) => {
  const sourceIdentity = await resolveThumbnailSourceIdentity(filePath);
  const hash = crypto.createHash('sha1');
  hash.update(sourceIdentity);
  return hash.digest('hex');
};

const buildTempThumbnailPath = (finalPath) =>
  `${finalPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;

const atomicWriteSharpFile = async (finalPath, pipeline) => {
  await ensureDir(path.dirname(finalPath));
  const tmpPath = buildTempThumbnailPath(finalPath);

  try {
    await pipeline.toFile(tmpPath);
    await fsPromises.rename(tmpPath, finalPath);
  } catch (error) {
    await fsPromises.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
};

const makeImageThumb = async (srcPath, destPath) => {
  const { size, quality } = await getThumbOptions();
  const pipeline = sharp(srcPath)
    .rotate()
    .resize({
      width: size,
      height: size,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })
    .webp({ quality, effort: 4 });

  await atomicWriteSharpFile(destPath, pipeline);
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

const resolveVideoSeekSeconds = async (filePath) => {
  if (THUMBNAIL_VIDEO_SEEK_PERCENT == null) {
    return THUMBNAIL_VIDEO_SEEK_SECONDS;
  }

  const duration = await probeDuration(filePath);
  if (!duration || !Number.isFinite(duration)) {
    return THUMBNAIL_VIDEO_SEEK_SECONDS;
  }

  return Math.max(0, Math.floor(duration * THUMBNAIL_VIDEO_SEEK_PERCENT));
};

const makeVideoThumb = async (srcPath, destPath) => {
  if (!canProcessVideoThumbnails) {
    logger.warn({ srcPath }, 'Skipping video thumbnail (no ffmpeg/ffprobe)');
    return;
  }

  const seconds = await resolveVideoSeekSeconds(srcPath);
  const { size, quality } = await getThumbOptions();

  await new Promise((resolve, reject) => {
    const inputOptions = ['-hide_banner', '-loglevel', 'error'];
    if (THUMBNAIL_VIDEO_THREADS > 0) {
      inputOptions.push('-threads', String(THUMBNAIL_VIDEO_THREADS));
    }

    if (env.FFMPEG_HWACCEL) {
      inputOptions.push('-hwaccel', env.FFMPEG_HWACCEL);
    }

    if (env.FFMPEG_HWACCEL_DEVICE) {
      inputOptions.push('-hwaccel_device', env.FFMPEG_HWACCEL_DEVICE);
    }

    if (env.FFMPEG_HWACCEL_OUTPUT_FORMAT) {
      inputOptions.push('-hwaccel_output_format', env.FFMPEG_HWACCEL_OUTPUT_FORMAT);
    }

    let stream = null;
    let pipeline = null;
    let command = null;
    let externalProcessId = null;
    let settled = false;

    const cleanup = ({ killProcess = false } = {}) => {
      if (killProcess) {
        try {
          command?.kill('SIGKILL');
        } catch (_) {
          // noop
        }
      }
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
      if (pipeline && !pipeline.destroyed) {
        pipeline.destroy();
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      unregisterExternalProcess(externalProcessId, 'error', error);
      cleanup({ killProcess: true });
      reject(error);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      unregisterExternalProcess(externalProcessId, 'success');
      cleanup();
      resolve();
    };

    command = ffmpeg(srcPath)
      .inputOptions(inputOptions)
      .seekInput(seconds)
      .outputOptions([
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        '1',
        '-vf',
        `scale=${size}:-1:flags=${THUMBNAIL_VIDEO_SCALE_FLAGS}`,
        '-threads',
        String(THUMBNAIL_VIDEO_THREADS),
        '-vcodec',
        'mjpeg',
        '-q:v',
        '4',
      ])
      .format('image2pipe')
      .on('start', () => {
        externalProcessId = registerExternalProcess('ffmpeg', srcPath, command?.ffmpegProc?.pid, {
          seekSeconds: seconds,
          size,
        });
      })
      .on('end', () => {
        unregisterExternalProcess(externalProcessId, 'success');
      })
      .on('error', fail);

    stream = command.pipe();
    stream.on('error', fail);

    (async () => {
      pipeline = sharp().webp({ quality, effort: 3 });
      stream.pipe(pipeline);
      atomicWriteSharpFile(destPath, pipeline).then(done).catch(fail);
    })().catch(fail);
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
    const externalProcessId = registerExternalProcess('convert', srcPath, convert.pid, { size });

    let stderr = '';
    convert.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    let settled = false;
    const pipeline = sharp().webp({ quality, effort: 4 });
    convert.stdout.pipe(pipeline);

    const cleanup = ({ killProcess = false } = {}) => {
      if (pipeline && !pipeline.destroyed) {
        pipeline.destroy();
      }
      if (killProcess && !convert.killed) {
        convert.kill('SIGKILL');
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      unregisterExternalProcess(externalProcessId, 'error', error);
      cleanup({ killProcess: true });
      reject(error);
    };

    convert.on('error', (err) => {
      fail(new Error(`Failed to spawn ImageMagick convert: ${err.message}`));
    });

    const convertDone = new Promise((resolveConvert, rejectConvert) => {
      convert.on('close', (code) => {
        if (code !== 0 && code !== null) {
          rejectConvert(new Error(`ImageMagick convert exited with code ${code}: ${stderr}`));
          return;
        }
        resolveConvert();
      });
    });

    Promise.all([atomicWriteSharpFile(destPath, pipeline), convertDone])
      .then(() => {
        if (settled) return;
        settled = true;
        unregisterExternalProcess(externalProcessId, 'success');
        resolve();
      })
      .catch(fail);
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
    await videoThumbnailQueue.add(() => makeVideoThumb(filePath, thumbPath));
    return;
  }

  throw new Error(`Unsupported file type: .${extension}`);
};

const buildThumbnailPaths = async (filePath) => {
  const key = await hashForFile(filePath);
  const thumbFile = `v${THUMBNAIL_CACHE_VERSION}-${key}.webp`;
  const thumbPath = path.join(directories.thumbnails, thumbFile);
  return { thumbFile, thumbPath };
};

const isThumbnailFresh = async (thumbPath, sourceStats = null, filePath = null) => {
  try {
    const [thumbStats, currentSourceStats] = await Promise.all([
      fsPromises.stat(thumbPath),
      sourceStats ? Promise.resolve(sourceStats) : fsPromises.stat(filePath),
    ]);

    return thumbStats.mtimeMs >= currentSourceStats.mtimeMs;
  } catch (_) {
    return false;
  }
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
    let shouldContinueCleanup = false;

    try {
      await ensureDir(directories.thumbnails);
      const dirents = await fsPromises.readdir(directories.thumbnails, { withFileTypes: true });
      const fileNames = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);

      const currentVersionPrefix = `v${THUMBNAIL_CACHE_VERSION}-`;
      const oldVersionNames = fileNames.filter(
        (name) => THUMBNAIL_CACHE_FILE_PATTERN.test(name) && !name.startsWith(currentVersionPrefix)
      );
      const oversizedCount = Math.max(0, fileNames.length - THUMBNAIL_CACHE_MAX_FILES);
      const deleteCount = Math.min(
        Math.max(oldVersionNames.length, oversizedCount),
        THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE
      );

      if (deleteCount <= 0) {
        return;
      }

      const toDelete = [
        ...oldVersionNames,
        ...fileNames.filter((name) => !oldVersionNames.includes(name)),
      ].slice(0, deleteCount);

      let deleted = 0;
      for (const name of toDelete) {
        try {
          await fsPromises.rm(path.join(directories.thumbnails, name), { force: true });
          deleted += 1;
        } catch (_) {
          // Best-effort cache cleanup.
        }
      }

      logger.info(
        {
          deleted,
          before: fileNames.length,
          remainingEstimate: Math.max(0, fileNames.length - deleted),
          max: THUMBNAIL_CACHE_MAX_FILES,
          batchSize: THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE,
          oldVersionCandidates: oldVersionNames.length,
        },
        'Thumbnail cache cleanup batch completed'
      );
      thumbnailStats.cacheCleanupDeleted += deleted;
      logThumbnailDiagnostics('cache-cleanup', { cleanupDeleted: deleted });

      if (
        oldVersionNames.length > deleted ||
        fileNames.length - deleted > THUMBNAIL_CACHE_MAX_FILES
      ) {
        shouldContinueCleanup = true;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Thumbnail cache cleanup failed');
    } finally {
      thumbnailCacheCleanupPromise = null;
      if (shouldContinueCleanup) {
        scheduleThumbnailCacheCleanup({
          force: true,
          delayMs: THUMBNAIL_CACHE_CONTINUE_DELAY_MS,
        });
      }
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

scheduleThumbnailCacheCleanup({ force: true, delayMs: 2 * 60 * 1000 });

const getThumbnailPathIfExists = async (filePath, stats = null) => {
  if (!THUMBNAILS_ENABLED || isThumbnailCachePath(filePath)) {
    return '';
  }

  const extension = path.extname(filePath).toLowerCase().slice(1);
  if (isPdf(extension)) {
    return '';
  }

  const { thumbFile, thumbPath } = await buildThumbnailPaths(filePath);

  try {
    if (!(await isThumbnailFresh(thumbPath, stats, filePath))) {
      return '';
    }
    return `/static/thumbnails/${thumbFile}`;
  } catch (error) {
    return '';
  }
};

const getThumbnail = async (filePath) => {
  if (!THUMBNAILS_ENABLED || isThumbnailCachePath(filePath)) {
    return '';
  }
  thumbnailStats.requests += 1;

  const extension = path.extname(filePath).toLowerCase().slice(1);
  if (isPdf(extension)) {
    return '';
  }

  const sourceStats = await fsPromises.stat(filePath);
  const { thumbFile, thumbPath } = await buildThumbnailPaths(filePath);

  // Check if thumbnail already exists (fast path)
  if (await isThumbnailFresh(thumbPath, sourceStats, filePath)) {
    failedThumbnails.delete(thumbPath);
    thumbnailStats.cacheHits += 1;
    return `/static/thumbnails/${thumbFile}`;
  }

  if (getFailedThumbnail(thumbPath)) {
    thumbnailStats.failedTtlSkips += 1;
    return '';
  }

  // Update queue concurrency from settings (non-blocking)
  updateQueueConcurrency().catch(() => {});

  // Check if generation is already in progress for this file
  let pending = inflight.get(thumbPath);
  if (!pending) {
    thumbnailStats.queued += 1;
    // Queue the thumbnail generation with concurrency limit
    pending = thumbnailQueue
      .add(async () => {
        const jobId = startThumbnailJob(filePath, thumbPath);
        try {
          // Double-check if another request created it while we were queued
          try {
            if (!(await isThumbnailFresh(thumbPath, sourceStats, filePath))) {
              throw new Error('Stale or missing thumbnail');
            }
            thumbnailStats.cacheHits += 1;
            finishThumbnailJob(jobId, 'cache-hit');
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
            thumbnailStats.generated += 1;
            finishThumbnailJob(jobId, 'generated');
            return `/static/thumbnails/${thumbFile}`;
          } catch (missing) {
            logger.warn(
              { filePath, thumbPath },
              'Thumbnail generation completed but file not found'
            );
            finishThumbnailJob(jobId, 'missing');
            return '';
          }
        } catch (error) {
          thumbnailStats.failed += 1;
          markFailedThumbnail(thumbPath);
          logger.error({ filePath, err: error }, 'Thumbnail generation failed');
          finishThumbnailJob(jobId, 'error', error);
          throw error;
        }
      })
      .finally(() => {
        // Clean up inflight map when done
        inflight.delete(thumbPath);
        scheduleSharpCacheTrim();
      });

    inflight.set(thumbPath, pending);
  }

  return pending;
};

const queueThumbnailGeneration = (filePath) => {
  if (!THUMBNAILS_ENABLED || !filePath || isThumbnailCachePath(filePath)) {
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
  isThumbnailCachePath,
  queueThumbnailGeneration,
};
