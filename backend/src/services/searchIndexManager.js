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
 */

let running = false;
let stopped = false;
let controller = null;
let timer = null;

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
    const db = await getDb();
    const result = await indexTree({
      db,
      rootAbs: directories.volume,
      signal: controller.signal,
      batchSize: searchConfig.index.batch,
      pauseMs: searchConfig.index.pauseMs,
      onProgress: ({ indexed, skipped }) => {
        logger.info({ indexed, skipped, reason }, 'Search index still building');
      },
    });

    logger.info(
      { ...result, reason, ms: Date.now() - startedAt, documents: store.stats(db).documents },
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
  // Deliberately not awaited: a server does not wait for its index to be
  // ready, it answers from the live search until it is.
  reconcile({ reason: 'startup' });

  timer = setInterval(() => {
    reconcile({ reason: 'scheduled' });
  }, searchConfig.index.reconcileMs);
  // Never a reason to keep the process alive.
  timer.unref?.();

  logger.info(
    { reconcileMs: searchConfig.index.reconcileMs, pauseMs: searchConfig.index.pauseMs },
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

  try {
    const db = await getDb();
    await indexFile(db, relative, absolutePath);
  } catch (error) {
    logger.debug({ err: error, relative }, 'Could not update the search index for a file');
  }
};

/** A file or folder the application removed. */
const onPathRemoved = async (absolutePath) => {
  if (!enabled() || stopped) return;

  const relative = relativeToVolume(absolutePath);
  if (!relative) return;

  try {
    const db = await getDb();
    store.removeUnder(db, relative);
  } catch (error) {
    logger.debug({ err: error, relative }, 'Could not remove a path from the search index');
  }
};

/** A rename or a move: the words did not change, only where they live. */
const onPathMoved = async (fromAbsolutePath, toAbsolutePath) => {
  if (!enabled() || stopped) return;

  const from = relativeToVolume(fromAbsolutePath);
  const to = relativeToVolume(toAbsolutePath);

  try {
    const db = await getDb();
    if (from && to) {
      store.movePath(db, from, to);
      return;
    }
    // Out of scope on one side: forget what left, read what arrived.
    if (from) store.removeUnder(db, from);
    if (to) await indexFile(db, to, toAbsolutePath);
  } catch (error) {
    logger.debug({ err: error, from, to }, 'Could not follow a move in the search index');
  }
};

/** What the index holds, for diagnostics. */
const status = async () => {
  if (!enabled()) return { enabled: false };

  try {
    const db = await getDb();
    return { enabled: true, running, ...store.stats(db) };
  } catch {
    return { enabled: true, running, documents: 0 };
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
