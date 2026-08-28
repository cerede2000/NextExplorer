const fs = require('fs/promises');
const path = require('path');

const logger = require('../utils/logger');

/**
 * Remove what a killed upload left behind.
 *
 * `uploadService` writes to `<final name>.uploading` and renames on success.
 * Every failure it can observe cleans up after itself, but nothing survives the
 * process being killed: restart the container mid-upload and a half-written
 * `holiday.mp4.uploading` stays in the folder for good, with nothing anywhere
 * that would ever remove it. The chunked path has `cleanupInactiveUploads` for
 * exactly this; the direct one had nothing.
 *
 * Swept where an upload is about to happen, rather than by walking every volume
 * at startup. The remains are in the folders people upload to, and a full walk
 * would cost an entire tree on every boot to reach the ones nobody will open
 * again — which the `.uploading` hidden-file pattern already keeps out of
 * sight.
 */

const UPLOADING_SUFFIX = '.uploading';

/**
 * A whole day.
 *
 * An upload in flight rewrites its temporary file continuously, and a stalled
 * one is killed after two minutes of silence, so anything a day old is
 * certainly dead several times over. The margin is for the other reading of
 * this function: it deletes a file it did not create, on the strength of a
 * name, and someone's own `notes.uploading` deserves not to vanish while they
 * are away from their desk.
 */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the stale `.uploading` files directly inside `directory`, and answer
 * how many went. Never throws: an upload must not fail because the tidying
 * before it could not be done.
 */
const sweepStaleUploadRemnants = async (
  directory,
  { staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}
) => {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (err) {
    logger.debug({ directory, err }, 'Could not look for the remains of interrupted uploads');
    return 0;
  }

  const cutoff = Date.now() - staleAfterMs;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(UPLOADING_SUFFIX)) continue;

    const remnant = path.join(directory, entry.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const stats = await fs.stat(remnant);
      if (stats.mtimeMs > cutoff) continue;

      // eslint-disable-next-line no-await-in-loop
      await fs.rm(remnant, { force: true });
      removed += 1;
      logger.info(
        { remnant, ageMs: Math.round(Date.now() - stats.mtimeMs) },
        'Removed the remains of an interrupted upload'
      );
    } catch (err) {
      logger.debug({ remnant, err }, 'Could not remove the remains of an interrupted upload');
    }
  }

  return removed;
};

module.exports = {
  sweepStaleUploadRemnants,
  UPLOADING_SUFFIX,
  DEFAULT_STALE_AFTER_MS,
};
