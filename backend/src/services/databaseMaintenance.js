const logger = require('../utils/logger');

/**
 * Handing the database's free space back to the filesystem.
 *
 * SQLite never shrinks a file on its own. The pages a deletion frees are kept
 * and reused, which suits a database whose size is steady, and does not suit
 * this one: it holds derived data that comes and goes by the gigabyte — a
 * search index over folders later excluded, an index a migration or a rebuild
 * throws away. One installation measured 2,159 MB for 160 MB of data; the rest
 * was free pages, copied into every backup of /config.
 *
 * Measured the other way round, the steady work does not need this: indexing
 * passes and rebuilds reuse what they free, and the file settles about a third
 * above its data. What needs handing back is what a large deletion leaves.
 *
 * So the file is kept in incremental auto-vacuum mode, and a pass hands free
 * pages back when there are enough of them to matter. A database created
 * before this has to be rewritten once to change mode; that happens when it is
 * opened, before anything else holds the connection.
 */

const AUTO_VACUUM_INCREMENTAL = 2;
const PASS_INTERVAL_MS = 60 * 60 * 1000;
// Below this, handing pages back is not worth the writes: SQLite reuses them.
const MIN_RECLAIM_BYTES = 16 * 1024 * 1024;
// Pages handed back per transaction. Each chunk holds the write lock for
// milliseconds, and requests get their turn between chunks.
const RECLAIM_CHUNK_PAGES = 2048;
// The write-ahead log keeps the largest size it has reached, and a backup of
// /config copies it too. A checkpoint cuts it back to this.
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

const toMb = (bytes) => Math.round(bytes / (1024 * 1024));

const pragmaNumber = (db, name) => Number(db.pragma(name, { simple: true }));

const measure = (db) => {
  const pageSize = pragmaNumber(db, 'page_size');
  const freePages = pragmaNumber(db, 'freelist_count');
  return {
    fileBytes: pragmaNumber(db, 'page_count') * pageSize,
    freeBytes: freePages * pageSize,
    freePages,
  };
};

const isIncremental = (db) => pragmaNumber(db, 'auto_vacuum') === AUTO_VACUUM_INCREMENTAL;

/**
 * What has to be set on a connection before the first table exists. On a new
 * file the auto-vacuum mode takes effect at once; on an existing one it waits
 * for the rewrite in convertToIncremental.
 */
const configureStorage = (db) => {
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  db.pragma('auto_vacuum = INCREMENTAL');
};

/**
 * Rewrite a database created before incremental auto-vacuum. Once: a database
 * already in that mode is left alone. Never throws — a file that could not be
 * rewritten, for want of temporary space say, is still a database the
 * application can run on, and the next start tries again.
 */
const convertToIncremental = (db) => {
  if (isIncremental(db)) return { converted: false };

  const before = measure(db);
  const startedAt = Date.now();
  try {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn(
      { err: error, fileMb: toMb(before.fileBytes), freeMb: toMb(before.freeBytes) },
      '[DB] Could not rewrite the database so that its free space can be handed back; the next start tries again'
    );
    return { converted: false, error };
  }

  const after = measure(db);
  logger.info(
    {
      beforeMb: toMb(before.fileBytes),
      afterMb: toMb(after.fileBytes),
      durationMs: Date.now() - startedAt,
    },
    '[DB] Rewrote the database once so that its free space can be handed back from now on'
  );
  return { converted: isIncremental(db), beforeBytes: before.fileBytes, afterBytes: after.fileBytes };
};

const yieldToRequests = () => new Promise((resolve) => setImmediate(resolve));

/** Hand free pages back, a chunk at a time. Answers what the file lost. */
const reclaimFreePages = async (
  db,
  { minBytes = MIN_RECLAIM_BYTES, chunkPages = RECLAIM_CHUNK_PAGES } = {}
) => {
  const before = measure(db);
  if (!isIncremental(db)) {
    return { reclaimedBytes: 0, skipped: 'not-incremental', freeBytes: before.freeBytes };
  }
  if (before.freeBytes < minBytes) {
    return { reclaimedBytes: 0, skipped: 'below-threshold', freeBytes: before.freeBytes };
  }

  let remaining = before.freePages;
  while (remaining > 0) {
    db.pragma(`incremental_vacuum(${chunkPages})`);
    const left = pragmaNumber(db, 'freelist_count');
    // Nothing moved: stop rather than spin.
    if (left >= remaining) break;
    remaining = left;
    // eslint-disable-next-line no-await-in-loop
    await yieldToRequests();
  }

  // Lets the file itself shrink. PASSIVE, because the other modes wait for
  // readers to finish — on the server's only thread, for as long as the busy
  // timeout. A reader in the middle of a transaction holds it up; the pages
  // are no longer in use either way, and the next checkpoint finishes it.
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch (error) {
    logger.debug({ err: error }, '[DB] Checkpoint after handing space back did not complete');
  }

  const after = measure(db);
  return {
    reclaimedBytes: before.fileBytes - after.fileBytes,
    fileBytes: after.fileBytes,
    freeBytes: after.freeBytes,
  };
};

let interval = null;
let running = null;

const runPass = ({ reason = 'scheduled' } = {}) => {
  if (running) return running;
  running = (async () => {
    // Required here rather than at the top: db.js requires this module.
    // eslint-disable-next-line global-require
    const db = await require('./db').getDb();
    const result = await reclaimFreePages(db);
    if (result.reclaimedBytes > 0) {
      logger.info(
        { reason, reclaimedMb: toMb(result.reclaimedBytes), fileMb: toMb(result.fileBytes) },
        '[DB] Handed free space back to the filesystem'
      );
    } else if (result.skipped === 'not-incremental' && result.freeBytes >= MIN_RECLAIM_BYTES) {
      logger.warn(
        { reason, freeMb: toMb(result.freeBytes) },
        '[DB] Free space is kept until the database can be rewritten at a start'
      );
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
};

const start = () => {
  if (interval) return;
  runPass({ reason: 'startup' }).catch((error) =>
    logger.warn({ err: error }, '[DB] Handing free space back at startup failed')
  );
  interval = setInterval(() => {
    runPass().catch((error) =>
      logger.warn({ err: error }, '[DB] Handing free space back failed')
    );
  }, PASS_INTERVAL_MS);
  interval.unref?.();
};

const stop = () => {
  if (interval) clearInterval(interval);
  interval = null;
};

module.exports = {
  MIN_RECLAIM_BYTES,
  PASS_INTERVAL_MS,
  WAL_SIZE_LIMIT_BYTES,
  configureStorage,
  convertToIncremental,
  reclaimFreePages,
  runPass,
  start,
  stop,
};
