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

/**
 * The same, for the extracted tree of a solid archive.
 *
 * A directory rather than a file, because what is kept is what came out: a
 * solid `.7z` compresses every file into one stream, so reading the last entry
 * decompresses the ones before it and there is nothing smaller to keep that
 * would answer the next read.
 */
const CACHED_TREE_NAME = /^v\d+-[0-9a-f]+\.tree$/;
const TEMPORARY_TREE_NAME = /^v\d+-[0-9a-f]+\.tree\.tmp-/;

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

/** What a cached tree weighs: everything under it, files only. */
const sizeOfTree = async (treePath) => {
  let total = 0;
  const walk = async (directory) => {
    let contents;
    try {
      contents = await fs.readdir(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const item of contents) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      // Never follows a link: what is counted is what this cache wrote, and it
      // was written with symbolic links turned off.
      if (!item.isFile()) continue;
      const stats = await fs.stat(full).catch(() => null);
      if (stats) total += stats.size;
    }
  };
  await walk(treePath);
  return total;
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
 * Everything a solid archive holds, extracted once into the cache.
 *
 * Measured on a runner with a real 7-Zip, on two hundred files of two hundred
 * and fifty-six kilobytes that compress about two to one: reading the first
 * entry takes 0.02 s, the middle one 0.70 s, the last 1.37 s — the cost is the
 * entries before the one asked for. Extracting the whole archive takes 1.41 s,
 * about what reading the last entry alone costs, and ten entries read one at a
 * time take 6.95 s. So the second read of a solid archive is where this pays:
 * it costs about what that read was going to cost anyway, and every read after
 * it is a file on disk. (`scripts/measure-solid-7z.mjs`, and the workflow that
 * runs it.)
 *
 * Deliberately not the first read: somebody who opens one small file near the
 * front would wait 1.4 s instead of 0.02 s for a tree nobody asks for again.
 */
const extractInto = async (archiveAbsolutePath, destination) => {
  await ensureDir(destination);
  // -snl- keeps 7-Zip from restoring symbolic links; -spd from reading a name
  // as a pattern. The same two the extraction onto the volume uses.
  const child = spawn(
    SEVEN_ZIP_BIN,
    ['x', '-y', '-p', '-snl-', '-spd', `-o${destination}`, '--', archiveAbsolutePath],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let output = '';
  child.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-2000);
  });

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`7z exited with code ${code}: ${output.trim()}`))
    );
  });
};

const treePathFor = async (archiveAbsolutePath) =>
  path.join(cacheDirectory(), `v${CACHE_VERSION}-${await fingerprintOf(archiveAbsolutePath)}.tree`);

/**
 * The tree this archive was already extracted into, or null.
 *
 * Asked before every read, because a tree that exists answers for nothing —
 * the first read of an archive whose tree is already there is as free as the
 * tenth.
 */
const existingSolidTree = async (archiveAbsolutePath) => {
  const treePath = await treePathFor(archiveAbsolutePath).catch(() => null);
  if (!treePath || !(await pathExists(treePath))) return null;
  // Using one is reading it, so the sweep counts it as recently used.
  const now = new Date();
  await fs.utimes(treePath, now, now).catch(() => {});
  return treePath;
};

/**
 * Extract it, and answer with where it went.
 *
 * Written under a name of our own and renamed into place only once it is
 * whole, so an extraction interrupted half way leaves a temporary directory
 * the sweep takes rather than a tree that is missing its end.
 *
 * @param {string} archiveAbsolutePath the solid archive
 * @param {number} uncompressedBytes what its listing says it holds
 */
const cachedSolidTree = async (archiveAbsolutePath, uncompressedBytes) => {
  if (!Number.isFinite(uncompressedBytes) || uncompressedBytes < 0) return null;
  if (uncompressedBytes > archives.browseMaxBytes) return null;

  const existing = await existingSolidTree(archiveAbsolutePath);
  if (existing) return existing;

  const directory = await ensureCacheDirectory();
  const finalPath = await treePathFor(archiveAbsolutePath);

  let pending = inflight.get(finalPath);
  if (!pending) {
    pending = (async () => {
      await ensureStorageAvailable(directory, uncompressedBytes, 'archive cache');

      const temporaryPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      liveTempFiles.add(path.basename(temporaryPath));
      try {
        await extractInto(archiveAbsolutePath, temporaryPath);
        await fs.rename(temporaryPath, finalPath);
        return finalPath;
      } finally {
        await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
        liveTempFiles.delete(path.basename(temporaryPath));
      }
    })().finally(() => inflight.delete(finalPath));

    inflight.set(finalPath, pending);
  }

  // A cache is a convenience: an extraction that fails leaves the read to go
  // to the archive itself, which is what it did before this existed.
  return pending.catch(() => null);
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
  const abandonedTrees = await findAbandonedTempFiles(directory, names, {
    pattern: TEMPORARY_TREE_NAME,
    live: liveTempFiles,
  });
  for (const name of [...abandoned, ...abandonedTrees]) {
    await fs.rm(path.join(directory, name), { recursive: true, force: true }).catch(() => {});
  }

  const cached = names.filter((name) => CACHED_NAME.test(name) || CACHED_TREE_NAME.test(name));
  const entries = [];
  for (const name of cached) {
    try {
      const full = path.join(directory, name);
      const stats = await fs.stat(full);
      // A tree's size is what is under it. Walked here rather than remembered,
      // because the sweep is the one place that has to be right about it and
      // it runs once an hour, not once a read.
      const size = stats.isDirectory() ? await sizeOfTree(full) : stats.size;
      entries.push({ name, mtimeMs: stats.mtimeMs, size });
    } catch (_) {
      // Taken by another pass, or by the rename of a copy being made.
    }
  }

  const now = Date.now();
  const kept = [];
  for (const entry of entries) {
    if (CACHE_TTL_MS > 0 && now - entry.mtimeMs > CACHE_TTL_MS) {
      await fs
        .rm(path.join(directory, entry.name), { recursive: true, force: true })
        .catch(() => {});
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
    await fs.rm(path.join(directory, entry.name), { recursive: true, force: true }).catch(() => {});
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
  cachedSolidTree,
  existingSolidTree,
  sweepArchiveCache,
  stopArchiveCacheWork,
  cacheDirectory,
  statCacheEntries,
};
