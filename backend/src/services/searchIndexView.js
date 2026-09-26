const fs = require('fs/promises');
const path = require('path');

const { directories } = require('../config/index');
const { normalizeRelativePath, isInsidePersonalRoot } = require('../utils/pathUtils');
const store = require('./searchIndexStore');

/**
 * The index, seen from where a search starts.
 *
 * The index names every file by its path in the volume. A search names them by
 * the path the reader used to get there: `share/<token>/…` inside a link,
 * `personal/…` in somebody's own folder, `<label>/…` in a volume an
 * administrator assigned. The same file, two names — and a search that asked
 * the index in the reader's words matched nothing, so a share and a personal
 * folder were sent back to reading the storage, on every keystroke.
 *
 * A view is the translation in one place: the folder to ask the index about,
 * and the way back from each row it returns to the name the reader uses. The
 * way back is where a mistake would be a disclosure rather than a wrong
 * answer, so it refuses whatever does not sit strictly under that folder, and
 * whatever lies in a folder the search never enters.
 */

/**
 * @param {object} options
 * @param {string} options.base         the folder the index is asked about,
 *   relative to the volume; '' for the whole volume
 * @param {string} options.logicalBase  the same folder as the reader names it
 * @param {(name: string) => boolean} options.isIgnoredName  a folder name the
 *   search never walks into
 * @param {boolean} [options.baseInPersonalRoot]  whether the folder is itself
 *   inside somebody's personal folder
 */
const createIndexView = ({ base, logicalBase, isIgnoredName, baseInPersonalRoot = false }) => {
  const prefix = base ? `${base}/` : '';

  /**
   * The reader's name for a row, or null when the row is not one to offer.
   */
  const toLogical = (rowPath) => {
    if (typeof rowPath !== 'string' || !rowPath) return null;
    // Strictly under the folder. The folder itself is where the reader is
    // standing and not something they found; it lacks the trailing slash and
    // stops here, and a row that ends in one leaves an empty segment below.
    if (prefix && !rowPath.startsWith(prefix)) return null;
    const segments = rowPath.slice(prefix.length).split('/');
    if (segments.some((segment) => !segment)) return null;

    // The walk never enters these, so neither does an answer from the index.
    // The last segment is the entry itself, which the caller judges by name.
    if (segments.slice(0, -1).some((segment) => isIgnoredName(segment))) return null;

    // Somebody's personal folder, reached from outside it: an assigned volume
    // or a share of one may hold `_users` without the reader having any claim
    // on what is in it.
    if (!baseInPersonalRoot && isInsidePersonalRoot(toAbsolute(rowPath))) return null;

    const rest = segments.join('/');
    return logicalBase ? `${logicalBase}/${rest}` : rest;
  };

  const toAbsolute = (rowPath) => path.join(directories.volume, rowPath);

  return { base, logicalBase, toLogical, toAbsolute };
};

/**
 * Where a folder on disk sits in the volume, by its real path, or null when it
 * is not in the volume at all.
 *
 * By its real path because the pass does not follow links: a share whose
 * folder is reached through one has its files indexed under where they really
 * are. Outside the volume nothing is indexed — a personal root or an assigned
 * volume elsewhere on the disk.
 */
const volumePathOf = async (baseAbs) => {
  let realBase;
  let realVolume;
  try {
    [realBase, realVolume] = await Promise.all([
      fs.realpath(baseAbs),
      fs.realpath(directories.volume),
    ]);
  } catch {
    return null;
  }

  const relative = path.relative(realVolume, realBase);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizeRelativePath(relative.split(path.sep).join('/'));
};

/**
 * The view for a search based at `baseAbs`, which the reader calls
 * `logicalBase`; null when the index cannot answer there.
 *
 * Only for a folder the index has a row for. One inside an excluded folder,
 * inside a dot-folder, or created since the last pass is not covered, and
 * asking about it would answer with silence where the storage has files;
 * those are read as they always were. An index written before folders had
 * rows keeps the one base it could always answer for, a volume path searched
 * under its own name, until the next pass gives it the rest.
 */
const indexViewFor = async ({ db, baseAbs, logicalBase, isIgnoredName }) => {
  const base = await volumePathOf(baseAbs);
  if (base === null) return null;

  const covered =
    base === '' ||
    store.hasFolder(db, base) ||
    (!store.hasNameCatalogue(db) && base === logicalBase);
  if (!covered) return null;

  return createIndexView({
    base,
    logicalBase,
    isIgnoredName,
    baseInPersonalRoot: isInsidePersonalRoot(path.join(directories.volume, base)),
  });
};

module.exports = { createIndexView, volumePathOf, indexViewFor };
