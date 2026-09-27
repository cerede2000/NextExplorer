const path = require('path');
const fs = require('fs/promises');

const { ensureValidName } = require('../utils/pathUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const { takeInventory } = require('../utils/ownedTree');
const { ValidationError } = require('../errors/AppError');
const { archives } = require('../config/index');
const folderSizeHooks = require('./folderSizeHooks');

/**
 * What is shared between extracting a whole archive and extracting part of one.
 *
 * Both write into a hidden folder of their own first and then move what came
 * out of it into place, one entry at a time, by a move that never replaces
 * anything. Keeping that in one place is what stops the two drifting into
 * different answers to the same question — which name a file takes when
 * something already holds it.
 */

/**
 * Refuse an extraction whose declared footprint is past the limits.
 *
 * Extraction is otherwise unbounded: a few kilobytes of nested, highly
 * compressible entries can fill the volume ("zip bomb"). The declared sizes
 * come from the archive itself, so this is a cheap pre-flight check, not a
 * guarantee — it stops the accidental and the trivially malicious case.
 */
const ensureArchiveWithinLimits = ({ entryCount = 0, totalBytes = 0 }) => {
  if (entryCount > archives.maxEntries) {
    throw new ValidationError(
      `This archive holds more than ${archives.maxEntries} entries and was not extracted.`
    );
  }
  if (totalBytes > archives.maxExtractedBytes) {
    throw new ValidationError(
      'This archive expands beyond the allowed size and was not extracted.'
    );
  }
};

const buildItemMetadata = async (absolutePath, relativeParent, name) => {
  const stats = await fs.stat(absolutePath);
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = stats.isDirectory() ? 'directory' : ext.length > 10 ? 'unknown' : ext || 'unknown';

  return { name, path: relativeParent, kind, size: stats.size, dateModified: stats.mtime };
};

/**
 * Move everything a staging folder holds into the destination.
 *
 * Each entry takes the first name nothing holds — "name (1)" and so on — by a
 * move that never replaces or merges, and is taken stock of before it moves so
 * that undoing the extraction removes exactly what it wrote and not what
 * somebody put in a placed folder afterwards.
 */
const extractIntoCurrentFolder = async ({
  stagingDirectory,
  destinationDirectory,
  relativeParentPath,
  movedPaths,
}) => {
  const stagedEntries = await fs.readdir(stagingDirectory, { withFileTypes: true });
  const items = [];

  for (const entry of stagedEntries) {
    const entryName = ensureValidName(entry.name);
    const sourcePath = path.join(stagingDirectory, entryName);
    // Taken stock of before it moves: undoing the extraction removes exactly
    // this, and not what someone puts in a placed folder afterwards.
    const inventory = await takeInventory(sourcePath);
    // The name is taken by the move itself, never looked at first and renamed
    // into later: a file, or an empty folder, that appears under it meanwhile
    // stays as it is, and the entry goes to "name (1)".
    const { name: destinationName, path: destinationPath } = await placeWithoutOverwrite(
      sourcePath,
      destinationDirectory,
      entryName
    );
    movedPaths.push({ path: destinationPath, inventory });

    if (entry.isDirectory()) {
      folderSizeHooks.onDirectoryTreeCreated(destinationPath);
    } else {
      const stats = await fs.stat(destinationPath);
      folderSizeHooks.onFileWritten(destinationPath, stats.size);
    }

    items.push(await buildItemMetadata(destinationPath, relativeParentPath, destinationName));
  }

  return items;
};

module.exports = { ensureArchiveWithinLimits, buildItemMetadata, extractIntoCurrentFolder };
