const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const { directories, archives } = require('../config/index');
const { AppError } = require('../errors/AppError');
const { ensureDir, pathExists } = require('../utils/fsUtils');
const { ensureStorageAvailable } = require('./uploadStorageGuard');
const {
  CACHE_CLEANUP_INTERVAL_MS,
  CACHE_TTL_MS,
  findAbandonedTempFiles,
  statCacheEntries,
} = require('../utils/cacheCleanup');
const logger = require('../utils/logger');

const SEVEN_ZIP_BIN = process.env.SEVEN_ZIP_PATH || '7z';

/**
 * The inner tar of a compound archive, decompressed once and kept.
 *
 * `backup.tar.gz` is two archives: gzip wrapping a tar. 7-Zip peels one layer
 * per run, so listing it answers with a single entry called `backup.tar` —
 * true, and useless to somebody looking for a file inside it. The layer below
 * needs the tar, and a tar cannot be read from the middle: gzip has no index,
 * so reaching the last entry means decompressing everything before it. Doing
 * that per request would mean decompressing forty gigabytes to list a folder,
 * twice in a row for two clicks.
 *
 * So it is decompressed once, into the cache directory, and every listing and
 * every read of that archive goes to the copy. Never into the volume: a file
 * there would show up in listings, be read by the search index, counted in
 * folder sizes, and swept up by whatever backs the volume up.
 *
 * What is cached is the tar, not the tree it holds: one file, the size the
 * outer archive already declares, which is what makes refusing an archive too
 * large to hold a decision taken before anything is written rather than after.
 */

/** Bumped when the name or the contents of a cached file stop meaning the same. */
const CACHE_VERSION = 1;

/** What this service writes, and the only names it may ever take away. */
const CACHED_NAME = /^v\d+-[0-9a-f]+\.inner$/;
const TEMPORARY_NAME = /^v\d+-[0-9a-f]+\.inner\.tmp-/;

const cacheDirectory = () => path.join(directories.cache, 'archives');

const ensureCacheDirectory = async () => {
  const directory = cacheDirectory();
  await ensureDir(directory);
  return directory;
};

/**
 * The archive this cached copy belongs to: its path, its size and when it was
 * last written. An archive replaced by another of the same name is a different
 * archive, and gets a different copy rather than the previous one's contents.
 */
const fingerprintOf = async (archiveAbsolutePath) => {
  const stats = await fs.stat(archiveAbsolutePath);
  return crypto
    .createHash('sha1')
    .update(archiveAbsolutePath)
    .update(String(stats.size))
    .update(String(Math.floor(stats.mtimeMs)))
    .digest('hex');
};

const inflight = new Map();
const liveTempFiles = new Set();

const cacheError = (message, code, statusCode) => new AppError(message, statusCode, code);

/**
 * Decompress one layer of `archiveAbsolutePath` into `destination`.
 *
 * `-so` writes the inner archive to standard output, so what lands on disk is
 * written by us, under a name of our own, and renamed into place only once it
 * is whole: a decompression interrupted half way leaves a temporary file the
 * sweep takes, never a cached copy that is missing its end.
 */
const decompressInto = async (archiveAbsolutePath, destination) => {
  const child = spawn(SEVEN_ZIP_BIN, ['x', '-so', '-y', '-p', '--', archiveAbsolutePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-2000);
  });

  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`7z exited with code ${code}: ${output.trim()}`))
    );
  });

  try {
    await Promise.all([pipeline(child.stdout, fss.createWriteStream(destination)), exited]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
};

/**
 * Where to read a compound archive from: a decompressed copy of its inner
 * archive, made if it is not there yet.
 *
 * @param {string} archiveAbsolutePath the outer archive
 * @param {number} innerSize what the outer archive says the inner one weighs
 */
const cachedInnerArchive = async (archiveAbsolutePath, innerSize) => {
  if (!Number.isFinite(innerSize) || innerSize < 0) {
    throw cacheError(
      'This archive does not say how large it is inside, so it cannot be opened.',
      'ARCHIVE_UNREADABLE',
      422
    );
  }
  if (innerSize > archives.browseMaxBytes) {
    throw cacheError(
      'This archive is too large to look inside; extract it instead.',
      'ARCHIVE_TOO_LARGE_TO_BROWSE',
      413
    );
  }

  const directory = await ensureCacheDirectory();
  const finalPath = path.join(
    directory,
    `v${CACHE_VERSION}-${await fingerprintOf(archiveAbsolutePath)}.inner`
  );

  if (await pathExists(finalPath)) {
    // The sweep takes the least recently used first, and using one is reading
    // it: without this a cache that is working well is evicted on age alone.
    const now = new Date();
    await fs.utimes(finalPath, now, now).catch(() => {});
    return finalPath;
  }

  let pending = inflight.get(finalPath);
  if (!pending) {
    pending = (async () => {
      // Refused before anything is written rather than after the volume is
      // full: the cache directory is very often the one the database is on.
      await ensureStorageAvailable(directory, innerSize, 'archive cache');

      const temporaryPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      liveTempFiles.add(path.basename(temporaryPath));
      try {
        await decompressInto(archiveAbsolutePath, temporaryPath);
        await fs.rename(temporaryPath, finalPath);
        return finalPath;
      } catch (_) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw cacheError('This archive could not be opened.', 'ARCHIVE_UNREADABLE', 422);
      } finally {
        liveTempFiles.delete(path.basename(temporaryPath));
      }
    })().finally(() => inflight.delete(finalPath));

    inflight.set(finalPath, pending);
  }

  return pending;
};

/**
 * What the cache may hold, and for how long.
 *
 * A cached copy is a convenience: it can always be made again from the archive
 * it came from, so nothing here is ever missed. The budget is what keeps a few
 * large backups from filling a cache directory somebody sized for thumbnails.
 */
const sweepArchiveCache = async () => {
  const directory = cacheDirectory();
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (_) {
    return;
  }

  const abandoned = await findAbandonedTempFiles(directory, names, {
    pattern: TEMPORARY_NAME,
    live: liveTempFiles,
  });
  for (const name of abandoned) {
    await fs.rm(path.join(directory, name), { force: true }).catch(() => {});
  }

  const cached = names.filter((name) => CACHED_NAME.test(name));
  const entries = [];
  for (const name of cached) {
    try {
      const stats = await fs.stat(path.join(directory, name));
      entries.push({ name, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch (_) {
      // Taken by another pass, or by the rename of a copy being made.
    }
  }

  const now = Date.now();
  const kept = [];
  for (const entry of entries) {
    if (CACHE_TTL_MS > 0 && now - entry.mtimeMs > CACHE_TTL_MS) {
      await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => {});
      continue;
    }
    kept.push(entry);
  }

  let total = kept.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= archives.cacheMaxBytes) return;

  // Least recently read first: what nobody has opened in the longest time is
  // what costs least to make again.
  kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of kept) {
    if (total <= archives.cacheMaxBytes) break;
    await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => {});
    total -= entry.size;
  }
};

let cleanupTimer = null;
let stopped = false;

const scheduleArchiveCacheCleanup = (delayMs = CACHE_CLEANUP_INTERVAL_MS) => {
  if (stopped) return;
  cleanupTimer = setTimeout(async () => {
    try {
      await sweepArchiveCache();
    } catch (error) {
      logger.debug({ err: error }, 'Sweeping the archive cache failed');
    }
    scheduleArchiveCacheCleanup();
  }, delayMs);
  cleanupTimer.unref?.();
};

/** For a test's temporary cache, and for shutdown. */
const stopArchiveCacheWork = async () => {
  stopped = true;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = null;
  await Promise.allSettled([...inflight.values()]);
};

scheduleArchiveCacheCleanup(CACHE_CLEANUP_INTERVAL_MS);

module.exports = {
  cachedInnerArchive,
  sweepArchiveCache,
  stopArchiveCacheWork,
  cacheDirectory,
  statCacheEntries,
};
