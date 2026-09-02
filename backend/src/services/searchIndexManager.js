const path = require('path');

const { search: searchConfig, directories } = require('../config/index');
const { getDb } = require('./db');
const store = require('./searchIndexStore');
const { indexTree, indexFile } = require('./searchIndexer');
const logger = require('../utils/logger');

/**
 * When the index is built, and when it gets out of the way.
 *
 * One run at a time, abortable, and the abort is what shutdown uses: a walk
 * still going when the process is asked to stop would either hold it open or
 * be killed mid-transaction.
 *
 * Files change under the application as well as through it — an rsync, a
 * network share, someone at the console — so an incremental update is not
 * enough on its own. A periodic pass catches the rest, and it is the same walk
 * as the first one: everything unchanged is skipped without being opened, so
 * the cost of running it again is a stat per file.
 *
 * All of it goes through one worker, and that is the point rather than a
 * detail. The per-file updates are announced by the application and were
 * awaited by nobody, so copying a large folder started as many file reads as
 * there were files, all at once, on top of whatever pass was already running.
 * A background service gets one thread of work and a backlog with a bottom to
 * it; when the backlog is full the update is dropped, because the periodic
 * pass is exactly the thing that finds what was missed.
 */

let running = false;
let stopped = false;
let controller = null;
let timer = null;

/** How soon a pass that stopped on memory picks up where it left off. */
const RESUME_AFTER_MEMORY_MS = 2 * 60 * 1000;

/** The backlog of per-file work, and the single worker that drains it. */
const MAX_PENDING_UPDATES = 1000;
const pending = [];
let draining = false;
let dropped = 0;

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0 && !stopped) {
      const job = pending.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        await job();
      } catch (error) {
        logger.debug({ err: error }, 'A search index update failed');
      }
    }
  } finally {
    draining = false;
  }
};

const enqueue = (job) => {
  if (pending.length >= MAX_PENDING_UPDATES) {
    dropped += 1;
    if (dropped === 1 || dropped % 1000 === 0) {
      logger.info({ dropped }, 'Search index updates dropped; the next pass will catch them');
    }
    return Promise.resolve();
  }
  pending.push(job);
  return drain();
};

const enabled = () => searchConfig?.index?.enabled === true;

/** The path the index knows a file by, or null when it is outside its scope. */
const relativeToVolume = (absolutePath) => {
  if (!absolutePath) return null;

  const relative = path.relative(directories.volume, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
};

/** A pass over the whole volume. Never throws, never overlaps another. */
const reconcile = async ({ reason = 'scheduled' } = {}) => {
  if (!enabled() || running || stopped) return null;

  running = true;
  controller = new AbortController();
  const startedAt = Date.now();

  try {
    // Nothing else touching the index while a pass runs: the pass is already
    // the whole budget, and a read racing it is a read nobody accounted for.
    await drain();
    const db = await getDb();
    const result = await indexTree({
      db,
      rootAbs: directories.volume,
      signal: controller.signal,
      batchSize: searchConfig.index.batch,
      cpuPercent: searchConfig.index.cpuPercent,
      memoryBudgetBytes: searchConfig.index.memoryBudgetBytes,
      exclude: searchConfig.index.exclude,
      onProgress: ({ indexed, skipped, addedMb, rssMb, cpuPercent, cpuMs, pauses }) => {
        logger.info(
          { indexed, skipped, addedMb, rssMb, cpuPercent, cpuMs, pauses, reason },
          'Search index still building'
        );
      },
    });

    // Only a pass that reached the end can promise the index answers for the
    // whole volume, and that promise is what lets search stop reading the tree.
    if (!result.interrupted) store.markPassComplete(db);

    // A pass that stopped on memory has made real progress — what it wrote is
    // kept and skipped next time — but waiting the full interval to continue
    // would mean an index that takes days to become usable, or never does on a
    // volume large enough to hit the ceiling every time. It carries on shortly.
    if (result.stoppedForMemory && !stopped) {
      logger.info(
        { indexed: result.indexed, resumeInMs: RESUME_AFTER_MEMORY_MS },
        'Search index paused on memory and will carry on from where it stopped'
      );
      const resume = setTimeout(() => {
        reconcile({ reason: 'resume-after-memory' });
      }, RESUME_AFTER_MEMORY_MS);
      resume.unref?.();
    }

    logger.info(
      {
        ...result,
        reason,
        ms: Date.now() - startedAt,
        documents: store.stats(db).documents,
        ready: store.isReady(db),
      },
      'Search index updated'
    );
    return result;
  } catch (error) {
    logger.warn({ err: error, reason }, 'Search index pass failed');
    return null;
  } finally {
    running = false;
    controller = null;
  }
};

/** Start the first pass and schedule the ones after it. */
const start = () => {
  if (!enabled() || timer) return;

  stopped = false;

  if (searchConfig.index.rebuild) {
    // Deliberately before the first pass, so the rebuild is the pass rather
    // than a second one after it.
    enqueue(async () => {
      const db = await getDb();
      store.clear(db);
      logger.warn(
        'SEARCH_INDEX_REBUILD is set: the search index was emptied and will be read again ' +
          'from the files. Unset it once the rebuild has finished, or it happens every start.'
      );
    });
  }

  // Deliberately not awaited: a server does not wait for its index to be
  // ready, it answers from the live search until it is.
  reconcile({ reason: 'startup' });

  timer = setInterval(() => {
    reconcile({ reason: 'scheduled' });
  }, searchConfig.index.reconcileMs);
  // Never a reason to keep the process alive.
  timer.unref?.();

  logger.info(
    { reconcileMs: searchConfig.index.reconcileMs, cpuPercent: searchConfig.index.cpuPercent },
    'Search index started'
  );
};

/** Stop, and cut short whatever pass is in flight. */
const stop = () => {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  controller?.abort();
};

/**
 * A file the application itself changed. Cheap enough to do inline: one stat,
 * and a read only where something actually moved.
 */
const onFileChanged = async (absolutePath) => {
  if (!enabled() || stopped) return;

  const relative = relativeToVolume(absolutePath);
  if (!relative) return;

  await enqueue(async () => {
    const db = await getDb();
    await indexFile(db, relative, absolutePath);
  });
};

/** A file or folder the application removed. */
const onPathRemoved = async (absolutePath) => {
  if (!enabled() || stopped) return;

  const relative = relativeToVolume(absolutePath);
  if (!relative) return;

  await enqueue(async () => {
    const db = await getDb();
    store.removeUnder(db, relative);
  });
};

/** A rename or a move: the words did not change, only where they live. */
const onPathMoved = async (fromAbsolutePath, toAbsolutePath) => {
  if (!enabled() || stopped) return;

  const from = relativeToVolume(fromAbsolutePath);
  const to = relativeToVolume(toAbsolutePath);
  if (!from && !to) return;

  await enqueue(async () => {
    const db = await getDb();
    if (from && to) {
      store.movePath(db, from, to);
      return;
    }
    // Out of scope on one side: forget what left, read what arrived.
    if (from) store.removeUnder(db, from);
    if (to) await indexFile(db, to, toAbsolutePath);
  });
};

/** What the index holds, for diagnostics. */
const status = async () => {
  if (!enabled()) return { enabled: false };

  try {
    const db = await getDb();
    return {
      enabled: true,
      running,
      ready: store.isReady(db),
      pending: pending.length,
      dropped,
      ...store.stats(db),
    };
  } catch {
    return { enabled: true, running, pending: pending.length, dropped, documents: 0 };
  }
};

module.exports = {
  start,
  stop,
  reconcile,
  onFileChanged,
  onPathRemoved,
  onPathMoved,
  status,
  relativeToVolume,
};
