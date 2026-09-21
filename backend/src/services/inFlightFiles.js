const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { directories } = require('../config/index');
const logger = require('../utils/logger');

/**
 * What an operation is writing, recorded until it is done.
 *
 * Extracting or compressing an archive writes something that is not finished
 * yet — a staging folder, a new folder filling up, a hidden zip beside the
 * name it will take — and removes it when it fails.
 * Nothing removed it when the process was stopped half-way: a container
 * restarted mid-extraction left a `.nextexplorer-extract-*` folder, a
 * half-written zip or a half-filled folder in the volume for good, and the
 * hidden ones out of sight.
 *
 * So each operation records the path before creating it and releases the
 * record when it is done, however it ends. A record still there at the next
 * start belongs to an operation the stop interrupted, and what it names is
 * removed — only that: nothing is guessed from a name, and no volume is walked.
 *
 * Records live under the cache directory, one small file each, so they survive
 * the stop they are meant for and need nothing from the database.
 */

// Records written by this process are its own operations, still running.
const RUN_ID = crypto.randomUUID();

const journalDirectory = () => path.join(directories.cache, 'in-flight');

const NOT_RECORDED = Object.freeze({ release: () => {} });

/**
 * Record that `targetPath` is being written. Call before creating it, and call
 * `release()` when the operation is over, whether it succeeded or cleaned up.
 * Never throws: an operation must not fail because it could not be recorded.
 */
const track = (targetPath, kind) => {
  const record = path.join(journalDirectory(), `${crypto.randomUUID()}.json`);
  try {
    fs.mkdirSync(journalDirectory(), { recursive: true });
    fs.writeFileSync(
      record,
      JSON.stringify({
        path: path.resolve(targetPath),
        kind,
        runId: RUN_ID,
        startedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    logger.debug({ err: error, targetPath }, 'Could not record an operation in flight');
    return NOT_RECORDED;
  }

  return {
    // Releasing twice is harmless: the record is simply no longer there.
    release: () => {
      try {
        fs.rmSync(record, { force: true });
      } catch (error) {
        logger.debug({ err: error, record }, 'Could not release an in-flight record');
      }
    },
  };
};

/** Paths no record may ever take down, whatever it says. */
const protectedRoots = () =>
  new Set(
    [directories.volume, directories.userRoot, directories.cache, directories.config]
      .filter(Boolean)
      .map((root) => path.resolve(root))
  );

/**
 * Remove what operations interrupted by an earlier stop left behind, and their
 * records. Called at start, before anything else writes. Never throws.
 */
const sweepInterrupted = () => {
  let names;
  try {
    names = fs.readdirSync(journalDirectory());
  } catch {
    return { removed: 0 };
  }

  const roots = protectedRoots();
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = path.join(journalDirectory(), name);
    try {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(record, 'utf8'));
      } catch {
        // Unreadable: a record cut short by the stop itself names nothing sure.
      }
      if (data?.runId === RUN_ID) continue;

      const target = typeof data?.path === 'string' ? data.path : null;
      if (
        target &&
        path.isAbsolute(target) &&
        !roots.has(path.resolve(target)) &&
        path.resolve(target) !== path.parse(target).root &&
        fs.lstatSync(target, { throwIfNoEntry: false })
      ) {
        // rm does not follow a link it is asked to remove: a link goes, its
        // target stays.
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
      }
      fs.rmSync(record, { force: true });
    } catch (error) {
      logger.warn({ err: error, record }, 'Could not clear what an interrupted operation left');
    }
  }

  if (removed > 0) {
    logger.info({ removed }, 'Removed what operations interrupted by a stop had left behind');
  }
  return { removed };
};

module.exports = { track, sweepInterrupted, journalDirectory };
