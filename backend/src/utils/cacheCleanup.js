const path = require('path');
const fs = require('fs/promises');

const env = require('../config/env');
const { mapWithConcurrency } = require('./mapWithConcurrency');

/**
 * What the cache cleanups share.
 *
 * Thumbnails and embedded RAW previews are both written under a temporary name
 * and renamed into place, both live in the cache directory, and both come back
 * when missing. They are bounded by one reading of the same settings rather
 * than by two copies of it that can drift apart. Nothing here deletes: each
 * service decides what to remove, and removes it itself.
 */
const CACHE_CLEANUP_INTERVAL_MS = Number.isFinite(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS)
  ? Math.max(60 * 1000, Math.floor(env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS))
  : 60 * 60 * 1000;
const CACHE_CLEANUP_BATCH_SIZE = Number.isFinite(env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE)
  ? Math.max(1, Math.floor(env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE))
  : 500;
const CACHE_TTL_MS = Number.isFinite(env.THUMBNAIL_CACHE_TTL_DAYS)
  ? Math.max(0, Math.floor(env.THUMBNAIL_CACHE_TTL_DAYS)) * 24 * 60 * 60 * 1000
  : 30 * 24 * 60 * 60 * 1000;

/**
 * How long a temporary file must have gone unwritten before it counts as
 * abandoned.
 *
 * A thumbnail is written in well under a second, and its queue stops waiting
 * after thirty; an embedded preview is copied out faster still. An hour is far
 * past either, and a leftover that survives one more pass costs nothing. The
 * age is the modification time, which a write in progress keeps moving.
 */
const ABANDONED_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

const STAT_CONCURRENCY = 16;

/** The modification time of each name that still exists, in the order given. */
const statCacheEntries = async (directory, names) => {
  const entries = await mapWithConcurrency(
    names,
    async (name) => {
      try {
        const stats = await fs.stat(path.join(directory, name));
        return { name, mtimeMs: stats.mtimeMs };
      } catch (_) {
        // A rename or a concurrent cleanup may already have taken it.
        return null;
      }
    },
    STAT_CONCURRENCY
  );
  return entries.filter(Boolean);
};

/**
 * Temporary files that a crash, a killed process or an interrupted write left
 * behind.
 *
 * `pattern` names this cache's temporaries, so nothing else in the directory is
 * considered. `live` holds the names a write in this process has created and
 * not yet renamed or removed; those are kept however old they look, because
 * their rename is still to come. A queue that stops waiting for a job does not
 * stop the job, so neither "queued" nor "in flight" can stand in for it.
 * The age covers what `live` cannot see: a write from an earlier run.
 */
const findAbandonedTempFiles = async (
  directory,
  fileNames,
  { pattern, live, now = Date.now() }
) => {
  const candidates = fileNames.filter((name) => pattern.test(name) && !live.has(name));
  const entries = await statCacheEntries(directory, candidates);
  return entries
    .filter((entry) => now - entry.mtimeMs >= ABANDONED_TEMP_FILE_AGE_MS)
    .map((entry) => entry.name);
};

module.exports = {
  ABANDONED_TEMP_FILE_AGE_MS,
  CACHE_CLEANUP_BATCH_SIZE,
  CACHE_CLEANUP_INTERVAL_MS,
  CACHE_TTL_MS,
  findAbandonedTempFiles,
  statCacheEntries,
};
