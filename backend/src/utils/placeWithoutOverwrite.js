const fs = require('fs/promises');
const path = require('path');

const logger = require('./logger');
const { splitName } = require('./pathUtils');

/**
 * Put something under a name without ever replacing what already holds it.
 *
 * Choosing a free name first — `findAvailableName`, "report (1).pdf" — and
 * writing under it afterwards leaves a gap: whatever arrives under that name in
 * between, another upload, a copy, a file saved over SMB, is replaced by the
 * rename at the end, because rename(2) replaces a file silently. An upload that
 * lasts an hour holds the gap open for an hour.
 *
 * Here the name is taken by the operation that cannot replace anything:
 * - a file is linked under the new name, which fails when the name is taken,
 *   and its old name is then removed — a rename that refuses to overwrite;
 * - a symbolic link is made again under the new name, which fails the same
 *   way, and the old one removed;
 * - where the filesystem has no hard links (FAT, exFAT, some SMB shares), an
 *   empty file is created exclusively under the name and the source renamed
 *   over it: only that empty file of ours is replaced;
 * - a folder is created under the name, which fails when it is taken, and the
 *   source renamed over that empty folder, which fails in turn if anything was
 *   put inside it meanwhile.
 * Some filesystems — FUSE mounts, SMB shares — refuse a rename over an existing
 * entry altogether, even our own empty one. There a plain rename never replaces
 * anything, so once that placeholder is removed, the plain rename is the move.
 * A taken name moves on to the next candidate, "report (1).pdf", then
 * "report (2).pdf", each tried the same way rather than looked at first.
 */

// link(2) is refused this way where the filesystem has no hard links. EPERM is
// also a real permission refusal: the fallback then meets the same refusal and
// reports it.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EINVAL']);

// What a rename says when the name holds something.
const NAME_HELD = new Set(['ENOTEMPTY', 'EEXIST']);

// Far past any real folder; a bound so a name that can never be taken — a
// filesystem answering EEXIST to everything — ends in an error, not a loop.
const MAX_CANDIDATES = 10000;

const taken = (name) =>
  Object.assign(new Error(`The name is already taken: ${name}`), { code: 'EEXIST' });

/** The `index`-th name to try: the name itself, then "name (1).ext" — or "name 2" for folders. */
const candidateName = (desiredName, index, style = 'copy') => {
  if (index === 0) return desiredName;
  if (style === 'folder') return `${desiredName} ${index + 1}`;
  const { base, extension } = splitName(desiredName);
  return `${base} (${index})${extension}`;
};

/**
 * Remove the empty placeholder this module created, and nothing that has
 * content. Answers whether it removed one.
 */
const removeOwnPlaceholder = async (target, isDirectory) => {
  try {
    if (isDirectory) {
      // rmdir refuses a folder that is not empty.
      await fs.rmdir(target);
      return true;
    }
    const stats = await fs.lstat(target);
    if (stats.isFile() && stats.size === 0) {
      await fs.unlink(target);
      return true;
    }
  } catch {
    /* already gone, or no longer ours to remove */
  }
  return false;
};

const renameOverPlaceholder = async (source, target, isDirectory) => {
  if (isDirectory) {
    await fs.mkdir(target);
  } else {
    const handle = await fs.open(target, 'wx');
    await handle.close();
  }

  try {
    await fs.rename(source, target);
  } catch (error) {
    const removed = await removeOwnPlaceholder(target, isDirectory);
    if (!NAME_HELD.has(error.code)) throw error;
    // Something was put in the placeholder between its creation and the rename.
    if (!removed) throw taken(target);
    // The placeholder was still empty, and still refused: this filesystem does
    // not rename over an existing entry at all. A plain rename cannot replace
    // anything here, so it is the move; a name taken meanwhile refuses it too.
    try {
      await fs.rename(source, target);
    } catch (retryError) {
      if (NAME_HELD.has(retryError.code)) throw taken(target);
      throw retryError;
    }
  }
};

/**
 * Move `source` to exactly `target`, or throw an error with code `EEXIST` when
 * the name is taken. Nothing that holds `target` is ever replaced. Errors other
 * than a taken name, EXDEV among them, are thrown as they come.
 */
const moveNoReplace = async (source, target) => {
  const stats = await fs.lstat(source);

  if (stats.isFile() || stats.isSymbolicLink()) {
    try {
      if (stats.isSymbolicLink()) {
        // A link is made again rather than linked: linking a link follows it on
        // some systems. Its text is kept as it was, as a rename keeps it.
        await fs.symlink(await fs.readlink(source), target);
      } else {
        await fs.link(source, target);
      }
    } catch (error) {
      if (stats.isSymbolicLink() || !LINK_UNSUPPORTED.has(error.code)) throw error;
      await renameOverPlaceholder(source, target, false);
      return;
    }
    try {
      await fs.unlink(source);
    } catch (error) {
      // The entry is in place under its new name; the old name is only a second
      // link to it, left for the caller's own cleanup to find.
      logger.warn({ err: error, source, target }, 'An entry was placed, but its old name stayed');
    }
    return;
  }

  await renameOverPlaceholder(source, target, stats.isDirectory());
};

/**
 * Move `source` into `directory` under `desiredName`, or the first free name
 * after it. Answers the name and path it took.
 *
 * @param {object} [options]
 * @param {'copy'|'folder'} [options.style] "name (1).ext", or "name 2" as a new folder is named
 */
const placeWithoutOverwrite = async (source, directory, desiredName, { style = 'copy' } = {}) => {
  for (let index = 0; index < MAX_CANDIDATES; index += 1) {
    const name = candidateName(desiredName, index, style);
    const target = path.join(directory, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      await moveNoReplace(source, target);
      return { name, path: target };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw taken(path.join(directory, desiredName));
};

/**
 * Take the first free name for something about to be written in place — an
 * empty file, or an empty folder — and answer it. For a write that fills the
 * name directly rather than renaming into it: from here on the name is held,
 * and anything else asking for it moves on to the next.
 */
const reserveAvailableName = async (
  directory,
  desiredName,
  { isDirectory = false, style = 'copy' } = {}
) => {
  for (let index = 0; index < MAX_CANDIDATES; index += 1) {
    const name = candidateName(desiredName, index, style);
    const target = path.join(directory, name);
    try {
      if (isDirectory) {
        // eslint-disable-next-line no-await-in-loop
        await fs.mkdir(target);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const handle = await fs.open(target, 'wx');
        // eslint-disable-next-line no-await-in-loop
        await handle.close();
      }
      return { name, path: target };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw taken(path.join(directory, desiredName));
};

/**
 * The name `placeWithoutOverwrite` would take if nothing changed meanwhile, to
 * tell somebody what to expect — never to place anything under. By the time the
 * move happens the name may be held, and the move then takes the next one
 * itself. A name that cannot be looked at is answered as asked.
 */
const predictAvailableName = async (directory, desiredName, { style = 'copy' } = {}) => {
  for (let index = 0; index < MAX_CANDIDATES; index += 1) {
    const name = candidateName(desiredName, index, style);
    try {
      await fs.lstat(path.join(directory, name));
    } catch (error) {
      return error.code === 'ENOENT' ? name : desiredName;
    }
  }
  return desiredName;
};

module.exports = {
  predictAvailableName,
  candidateName,
  moveNoReplace,
  placeWithoutOverwrite,
  reserveAvailableName,
  removeOwnPlaceholder,
};
