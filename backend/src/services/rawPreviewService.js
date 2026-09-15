const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const { directories } = require('../config/index');
const env = require('../config/env');
const logger = require('../utils/logger');
const {
  CACHE_CLEANUP_BATCH_SIZE,
  CACHE_CLEANUP_INTERVAL_MS,
  CACHE_TTL_MS,
  findAbandonedTempFiles,
  statCacheEntries,
} = require('../utils/cacheCleanup');

let exiftoolSingleton = null;
let exiftoolCleanupRegistered = false;

const loadExiftool = () => {
  if (exiftoolSingleton) return exiftoolSingleton;
  try {
    // eslint-disable-next-line global-require
    const { exiftool } = require('exiftool-vendored');
    exiftoolSingleton = exiftool;

    if (!exiftoolCleanupRegistered) {
      exiftoolCleanupRegistered = true;
      const shutdown = async () => {
        try {
          await exiftoolSingleton?.end?.();
        } catch (_) {
          // ignore cleanup errors
        } finally {
          exiftoolSingleton = null;
        }
      };

      process.once('beforeExit', () => {
        shutdown().catch(() => {});
      });
      process.once('SIGINT', () => {
        shutdown().finally(() => process.exit(0));
      });
      process.once('SIGTERM', () => {
        shutdown().finally(() => process.exit(0));
      });
    }
  } catch (error) {
    exiftoolSingleton = null;
  }

  return exiftoolSingleton;
};

const RAW_PREVIEW_CACHE_VERSION = 1;
const RAW_PREVIEW_CACHE_MAX_FILES = Number.isFinite(env.RAW_PREVIEW_CACHE_MAX_FILES)
  ? Math.max(0, Math.floor(env.RAW_PREVIEW_CACHE_MAX_FILES))
  : 500;
const RAW_PREVIEW_FILE_PATTERN = /^v\d+-[a-f0-9]{40}\.jpg$/i;
const RAW_PREVIEW_TEMP_FILE_PATTERN = /^v\d+-[a-f0-9]{40}\.jpg\.tmp-\d+-\d+$/i;
const RAW_PREVIEW_FIRST_CLEANUP_DELAY_MS = 2 * 60 * 1000;
const RAW_PREVIEW_CONTINUE_DELAY_MS = 30 * 1000;

const inflight = new Map();
// Temporary files an extraction in this process has created and not yet
// renamed or removed, by name: the cleanup leaves them alone however old.
const liveTempFiles = new Set();

let cleanupPromise = null;
let cleanupTimer = null;
let cleanupStopped = false;

const hashForFile = async (filePath) => {
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash('sha1');
  hash.update(filePath);
  hash.update(String(stat.size));
  hash.update(String(Math.floor(stat.mtimeMs)));
  return hash.digest('hex');
};

const rawPreviewCacheDir = () => path.join(directories.cache, 'raw-previews');

const ensureRawPreviewCacheDir = async () => {
  const dir = rawPreviewCacheDir();
  await ensureDir(dir);
  return dir;
};

const tryExtract = async (exiftool, method, inputPath, outputPath) => {
  try {
    await exiftool[method](inputPath, outputPath);
  } catch (_) {
    return false;
  }

  return pathExists(outputPath);
};

/**
 * Keep the extracted previews within bounds.
 *
 * Nothing used to remove anything from this directory. The cache key includes
 * the RAW file's modification time, so every edit of a photo leaves its previous
 * preview behind for good, and an extraction interrupted by a crash leaves its
 * temporary file. The thumbnail cleanup's rules apply here too, with the same
 * interval, batch size and lifetime: another version's previews and those past
 * the lifetime go, abandoned temporary files go, and past the file limit the
 * oldest go first. A limit of zero lifts the limit on the count and nothing
 * else: it used to leave the directory unmanaged, previews of another version,
 * past their lifetime and abandoned temporary files included.
 */
const cleanupRawPreviewCache = async () => {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    let shouldContinue = false;

    try {
      const dir = rawPreviewCacheDir();
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Nothing extracted yet, or the cache is gone: nothing to bound.
        if (error.code === 'ENOENT') return;
        throw error;
      }

      const now = Date.now();
      const fileNames = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);
      const previews = (
        await statCacheEntries(
          dir,
          fileNames.filter((name) => RAW_PREVIEW_FILE_PATTERN.test(name))
        )
      ).sort((a, b) => a.mtimeMs - b.mtimeMs);

      const currentVersionPrefix = `v${RAW_PREVIEW_CACHE_VERSION}-`;
      const removableNames = new Set(
        previews
          .filter(
            (entry) =>
              !entry.name.startsWith(currentVersionPrefix) ||
              (CACHE_TTL_MS > 0 && now - entry.mtimeMs >= CACHE_TTL_MS)
          )
          .map((entry) => entry.name)
      );
      const abandonedTempNames = await findAbandonedTempFiles(dir, fileNames, {
        pattern: RAW_PREVIEW_TEMP_FILE_PATTERN,
        live: liveTempFiles,
        now,
      });
      const overflowCount =
        RAW_PREVIEW_CACHE_MAX_FILES > 0
          ? Math.max(0, previews.length - removableNames.size - RAW_PREVIEW_CACHE_MAX_FILES)
          : 0;
      const wantedCount = abandonedTempNames.length + removableNames.size + overflowCount;

      if (wantedCount <= 0) {
        return;
      }

      const toDelete = [
        ...abandonedTempNames,
        ...removableNames,
        ...previews
          .filter((entry) => !removableNames.has(entry.name))
          .slice(0, overflowCount)
          .map((entry) => entry.name),
      ].slice(0, CACHE_CLEANUP_BATCH_SIZE);

      let deleted = 0;
      for (const name of toDelete) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fs.rm(path.join(dir, name), { force: true });
          deleted += 1;
        } catch (_) {
          // Best-effort cache cleanup.
        }
      }

      logger.info(
        {
          deleted,
          before: previews.length,
          max: RAW_PREVIEW_CACHE_MAX_FILES,
          batchSize: CACHE_CLEANUP_BATCH_SIZE,
          removableCandidates: removableNames.size,
          abandonedTempCandidates: abandonedTempNames.length,
        },
        'RAW preview cache cleanup batch completed'
      );

      shouldContinue = wantedCount > deleted;
    } catch (error) {
      logger.warn({ err: error }, 'RAW preview cache cleanup failed');
    } finally {
      cleanupPromise = null;
      scheduleRawPreviewCacheCleanup(
        shouldContinue ? RAW_PREVIEW_CONTINUE_DELAY_MS : CACHE_CLEANUP_INTERVAL_MS
      );
    }
  })();

  return cleanupPromise;
};

/**
 * One timer at a time, unref'd so it never holds the process open. Unlike the
 * thumbnails', this pass does not wait for new work to come along: a server
 * that only ever serves RAW previews would otherwise clean up once, at start.
 */
function scheduleRawPreviewCacheCleanup(delayMs) {
  if (cleanupStopped || cleanupTimer) {
    return;
  }

  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    cleanupRawPreviewCache().catch(() => {});
  }, delayMs);
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

scheduleRawPreviewCacheCleanup(RAW_PREVIEW_FIRST_CLEANUP_DELAY_MS);

/**
 * Extract embedded preview JPEG from a RAW file into a cached file path.
 * Returns absolute path to a JPEG file.
 */
const getRawPreviewJpegPath = async (rawFilePath) => {
  if (!rawFilePath) {
    throw new Error('rawFilePath is required');
  }

  const exiftool = loadExiftool();
  if (!exiftool) {
    throw new Error('exiftool-vendored is not available');
  }

  const cacheDir = await ensureRawPreviewCacheDir();
  const key = await hashForFile(rawFilePath);
  const finalPath = path.join(cacheDir, `v${RAW_PREVIEW_CACHE_VERSION}-${key}.jpg`);

  if (await pathExists(finalPath)) {
    return finalPath;
  }

  let pending = inflight.get(finalPath);
  if (!pending) {
    pending = (async () => {
      const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      const tmpName = path.basename(tmpPath);
      liveTempFiles.add(tmpName);

      try {
        await ensureDir(path.dirname(finalPath));

        const extracted =
          (await tryExtract(exiftool, 'extractPreview', rawFilePath, tmpPath)) ||
          (await tryExtract(exiftool, 'extractThumbnail', rawFilePath, tmpPath)) ||
          (await tryExtract(exiftool, 'extractJpgFromRaw', rawFilePath, tmpPath));

        if (!extracted) {
          try {
            await fs.rm(tmpPath, { force: true });
          } catch (_) {
            // ignore
          }
          throw new Error('No embedded preview JPEG found');
        }

        await fs.rename(tmpPath, finalPath);
        return finalPath;
      } finally {
        liveTempFiles.delete(tmpName);
      }
    })().finally(() => {
      inflight.delete(finalPath);
    });

    inflight.set(finalPath, pending);
  }

  return pending;
};

/**
 * Stop the cleanup for good, and let what is running finish.
 *
 * For a test's temporary cache or a shutdown: an extraction or a cleanup pass
 * still at work when its directory is removed fails the removal, and a timer
 * left behind runs against whatever comes next.
 */
const stopRawPreviewWork = async () => {
  cleanupStopped = true;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = null;

  await Promise.allSettled([...inflight.values(), cleanupPromise].filter(Boolean));
};

module.exports = {
  getRawPreviewJpegPath,
  // Exported for the tests: the cleanup is otherwise reached only through its timer.
  cleanupRawPreviewCache,
  stopRawPreviewWork,
};
