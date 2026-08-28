const fs = require('fs/promises');

const { upload: uploadConfig } = require('../config');
const { ensureDir } = require('../utils/fsUtils');
const { InsufficientStorageError } = require('../errors/AppError');
const logger = require('../utils/logger');

/**
 * Refuse an upload that cannot fit, rather than filling the volume with it.
 *
 * A full volume is not only a failed upload. Where `/config` sits on the same
 * filesystem — the ordinary single-volume deployment — SQLite stops being able
 * to write and the application stops working, for everyone rather than for the
 * person uploading. `UPLOAD_STORAGE_RESERVE` is the cushion kept free so that
 * running out lands on the upload instead of on the database.
 *
 * This is a guard, not a guarantee: `statfs` is not available on every
 * platform, the size of what is coming is not always known, and two uploads
 * racing can each be told there is room for them. It narrows the window, and
 * the reserve absorbs what gets through.
 */

/** Free bytes on the filesystem holding `directory`, or null when unknowable. */
const getAvailableBytes = async (directory) => {
  if (typeof fs.statfs !== 'function') {
    return null;
  }

  try {
    await ensureDir(directory);
    const stats = await fs.statfs(directory);
    return stats.bavail * stats.bsize;
  } catch (err) {
    logger.warn({ directory, err }, 'Unable to inspect available storage for uploads');
    return null;
  }
};

/**
 * Throw when `uploadSize` bytes would not leave the reserve free in
 * `directory`. Stays silent when either number is unknown — refusing an upload
 * on a filesystem we cannot measure would cost more than the risk it avoids.
 */
const ensureStorageAvailable = async (directory, uploadSize, label) => {
  if (!Number.isFinite(uploadSize) || uploadSize < 0) {
    return;
  }

  const availableBytes = await getAvailableBytes(directory);
  if (!Number.isFinite(availableBytes)) {
    return;
  }

  const reserveBytes = uploadConfig?.storageReserveBytes ?? 64 * 1024 * 1024;
  const requiredBytes = uploadSize + reserveBytes;
  if (availableBytes < requiredBytes) {
    throw new InsufficientStorageError(
      `Not enough storage available in ${label}. Required ${requiredBytes} bytes including reserve, available ${availableBytes} bytes.`
    );
  }
};

module.exports = {
  getAvailableBytes,
  ensureStorageAvailable,
};
