const fs = require('fs/promises');

const { directories } = require('../config/index');
const { parsePathSpace } = require('../utils/pathUtils');
const { PATH_TABLES } = require('./pathBindingsService');
const { getDb } = require('./db');
const logger = require('../utils/logger');

/**
 * Report what points at a volume that is not there — and remove nothing.
 *
 * Favourites, shares, recent destinations and folder preferences all store a
 * path whose first segment names a volume. Remove a volume from the compose
 * file and those rows survive, pointing nowhere: the favourite still shows in
 * the sidebar and answers with an error when clicked.
 *
 * The obvious fix — delete them at startup — would be worse than the problem.
 * A volume that is absent is not a volume that is gone: an NFS or SMB mount may
 * not be ready when the container starts, an external disk may be unplugged for
 * a weekend, a compose line may be mistyped and corrected a minute later. Any
 * of those would silently destroy every user's favourites and shares, for good.
 * Only a person can tell "not mounted yet" from "never coming back", so this
 * says what it sees and leaves the decision to them.
 */

/** Volume names that can legitimately appear at the head of a stored path. */
const knownVolumeNames = async (db) => {
  const names = new Set();

  const entries = await fs.readdir(directories.volume, { withFileTypes: true }).catch((error) => {
    logger.debug({ err: error }, 'Volume root unreadable while checking stored paths');
    return null;
  });
  // Unreadable root: every path would look orphaned. Say nothing rather than
  // cry wolf about all of them.
  if (!entries) return null;

  for (const entry of entries) {
    if (entry.isDirectory()) names.add(entry.name);
  }

  // A per-user volume is addressed by its label, not by a directory under the
  // volume root — without these, every one of them would look missing.
  try {
    for (const row of db.prepare('SELECT DISTINCT label FROM user_volumes').all()) {
      if (row?.label) names.add(row.label);
    }
  } catch (error) {
    logger.debug({ err: error }, 'Could not read user volumes while checking stored paths');
  }

  return names;
};

/**
 * The volume a stored path belongs to, or null where it belongs to none —
 * a personal folder or a share token names a space of its own, not a volume.
 */
const volumeOf = (storedPath) => {
  const { space, rel } = parsePathSpace(storedPath || '');
  if (space !== 'volume' || !rel) return null;
  return rel.split('/')[0] || null;
};

/**
 * What the database points at that the filesystem does not have.
 * Returns null when the question cannot be answered.
 */
const findOrphanedBindings = async () => {
  const db = await getDb();
  const known = await knownVolumeNames(db);
  if (!known) return null;

  const missing = new Map();

  for (const { table, column } of PATH_TABLES) {
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT ${column} AS storedPath, COUNT(*) AS count FROM ${table} GROUP BY ${column}`
        )
        .all();
    } catch (error) {
      // A table that is not there yet (a migration mid-flight) is not a reason
      // to fail the check, let alone the startup it runs from.
      logger.debug({ err: error, table }, 'Skipped a table while checking stored paths');
      continue;
    }

    for (const row of rows) {
      const volume = volumeOf(row.storedPath);
      if (!volume || known.has(volume)) continue;

      const entry = missing.get(volume) || { volume, tables: {}, total: 0 };
      entry.tables[table] = (entry.tables[table] || 0) + Number(row.count || 0);
      entry.total += Number(row.count || 0);
      missing.set(volume, entry);
    }
  }

  return [...missing.values()].sort((a, b) => b.total - a.total);
};

/** Say what was found, once, at startup. Never throws. */
const reportOrphanedBindings = async () => {
  try {
    const orphaned = await findOrphanedBindings();
    if (!orphaned || orphaned.length === 0) return;

    logger.warn(
      {
        volumes: orphaned.map(({ volume, total, tables }) => ({ volume, total, tables })),
      },
      `Stored paths point at ${orphaned.length} volume(s) that are not available: ` +
        `${orphaned.map((entry) => `${entry.volume} (${entry.total})`).join(', ')}. ` +
        'Nothing has been removed — a volume that is not mounted yet looks exactly like one that is gone.'
    );
  } catch (error) {
    logger.debug({ err: error }, 'Could not check stored paths against available volumes');
  }
};

/**
 * The volume names a stored path may legitimately start with, or null when the
 * question cannot be answered — an unreadable volume root would otherwise make
 * everything look missing at once.
 */
const listKnownVolumeNames = async () => {
  const db = await getDb();
  return knownVolumeNames(db);
};

module.exports = {
  findOrphanedBindings,
  reportOrphanedBindings,
  listKnownVolumeNames,
  volumeOf,
};
