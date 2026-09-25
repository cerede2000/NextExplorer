const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const {
  normalizeRelativePath,
  combineRelativePath,
  ensureValidName,
} = require('../utils/pathUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const { ACTIONS, authorizeAndResolve, authorizePath } = require('./authorizationService');
const { getSharesForSourceTargets, deleteSharesByIds } = require('./sharesService');
const { track: trackInFlight } = require('./inFlightFiles');

const copyEntry = async (sourcePath, destinationPath, isDirectory) => {
  if (isDirectory) {
    if (typeof fs.cp === 'function') {
      await fs.cp(sourcePath, destinationPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } else {
      await ensureDir(destinationPath);
      const entries = await fs.readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(sourcePath, entry.name);
        const dest = path.join(destinationPath, entry.name);
        // eslint-disable-next-line no-await-in-loop
        await copyEntry(src, dest, entry.isDirectory());
      }
    }
  } else {
    await fs.copyFile(sourcePath, destinationPath);
  }
};

/*
 * A copy or a move looked for a free name, "note (1).txt", and wrote under it
 * afterwards. Whatever arrived under that name in between — another copy, a
 * file saved over SMB — was replaced by the copied file or by the rename of a
 * move, or poured into by a copied folder, and a copy lasting minutes held that
 * gap open for minutes. The name is now taken by the step that puts the entry
 * there, through placeWithoutOverwrite, which never replaces nor merges into
 * anything and moves on to "note (1).txt" when the name is held.
 */

/**
 * Copy `sourcePath` into a hidden entry of its own beside the destination, and
 * put it under `desiredName`, or the first free name after it, once whole. A
 * copy that fails removes only that hidden entry; one cut short by a stop is
 * removed at the next start, through the in-flight journal.
 */
const copyIntoPlace = async (sourcePath, directory, desiredName, isDirectory) => {
  const stagingPath = path.join(directory, `.nextexplorer-copy-${crypto.randomUUID()}`);
  const inFlight = trackInFlight(stagingPath, 'partial-copy');
  try {
    await copyEntry(sourcePath, stagingPath, isDirectory);
    return await placeWithoutOverwrite(stagingPath, directory, desiredName);
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  } finally {
    inFlight.release();
  }
};

/**
 * Move `sourcePath` under `desiredName` in `directory`, or the first free name
 * after it. To another disk, the entry is copied whole first, and the source
 * removed only once that copy is in place.
 */
const moveIntoPlace = async (sourcePath, directory, desiredName, isDirectory) => {
  try {
    return await placeWithoutOverwrite(sourcePath, directory, desiredName);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }
  const placed = await copyIntoPlace(sourcePath, directory, desiredName, isDirectory);
  await fs.rm(sourcePath, { recursive: isDirectory, force: true });
  return placed;
};

const transferItems = async (items, destination, operation, options = {}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required.');
  }

  const destinationRelative = normalizeRelativePath(destination);

  // Prevent copying/moving items directly to the root path
  if (!destinationRelative || destinationRelative.trim() === '') {
    throw new Error(
      'Cannot copy or move items to the root path. Please select a specific volume or folder first.'
    );
  }

  const context = {
    user: options.user || null,
    guestSession: options.guestSession || null,
  };

  const {
    allowed: destAllowed,
    accessInfo: destAccess,
    resolved: destResolved,
  } = await authorizeAndResolve(context, destinationRelative, ACTIONS.write);
  if (!destAllowed || !destResolved) {
    throw new Error(destAccess?.denialReason || 'Destination path is not writable.');
  }

  const { absolutePath: destinationAbsolute } = destResolved;

  await ensureDir(destinationAbsolute);

  const results = [];

  for (const item of items) {
    const sourceCombined = combineRelativePath(item.path || '', item.name);
    const {
      allowed: srcAllowed,
      accessInfo: srcAccess,
      resolved: srcResolved,
    } = await authorizeAndResolve(context, sourceCombined, ACTIONS.read);
    if (!srcAllowed || !srcResolved) {
      throw new Error(srcAccess?.denialReason || `Source path not accessible: ${sourceCombined}`);
    }

    const { relativePath: sourceRelative, absolutePath: sourceAbsolute } = srcResolved;

    if (!(await pathExists(sourceAbsolute))) {
      throw new Error(`Source path not found: ${sourceRelative}`);
    }

    if (operation === 'move') {
      const { allowed: deleteAllowed, accessInfo: deleteAccess } = await authorizePath(
        context,
        sourceCombined,
        ACTIONS.delete
      );
      if (!deleteAllowed) {
        throw new Error(deleteAccess?.denialReason || 'Cannot move items from this path.');
      }
    }

    const stats = await fs.stat(sourceAbsolute);
    const sourceParent = normalizeRelativePath(path.dirname(sourceRelative));

    if (operation === 'move' && destinationRelative === sourceParent) {
      results.push({ from: sourceRelative, to: sourceRelative, skipped: true });
      continue;
    }

    // The name the item lands under is joined onto the destination, which is
    // the only directory authorized above. Taken from the request as it came,
    // `../x` or `../../x` wrote beside or above it — out of a read-only parent,
    // out of a share into the volume. A new name has to be a name; without
    // one, the item keeps the name it has on disk, not the one the request
    // spelled.
    const desiredName =
      item.newName === undefined || item.newName === null || item.newName === ''
        ? path.basename(sourceAbsolute)
        : ensureValidName(item.newName);

    let placed;
    if (operation === 'copy') {
      placed = await copyIntoPlace(
        sourceAbsolute,
        destinationAbsolute,
        desiredName,
        stats.isDirectory()
      );
    } else if (operation === 'move') {
      placed = await moveIntoPlace(
        sourceAbsolute,
        destinationAbsolute,
        desiredName,
        stats.isDirectory()
      );
    } else {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    // The name actually taken: "note (1).txt" when "note.txt" was held.
    results.push({
      from: sourceRelative,
      to: combineRelativePath(destinationRelative, placed.name),
    });
  }

  return { destination: destinationRelative, items: results };
};

const getShareSourceTarget = (resolved, includeChildren = false) => {
  if (!resolved) return null;

  if (resolved.userVolume) {
    const sourcePath = resolved.innerRelativePath
      ? `${resolved.userVolume.id}/${resolved.innerRelativePath}`
      : resolved.userVolume.id;
    return {
      sourceSpace: 'user_volume',
      sourcePath,
      includeChildren,
    };
  }

  return {
    sourceSpace: resolved.space || 'volume',
    sourcePath: resolved.innerRelativePath || resolved.relativePath || '',
    includeChildren,
  };
};

const resolveDeleteTargets = async (items = [], context) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required.');
  }

  const targets = [];

  for (const item of items) {
    const combined = combineRelativePath(item.path || '', item.name);
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      combined,
      ACTIONS.delete
    );
    if (!allowed || !resolved) {
      throw new Error(accessInfo?.denialReason || 'Cannot delete items from this path.');
    }

    const { relativePath, absolutePath } = resolved;
    const exists = await pathExists(absolutePath);
    const stats = exists ? await fs.stat(absolutePath) : null;
    const isDirectory = stats ? stats.isDirectory() : item?.kind === 'directory';

    targets.push({
      item,
      relativePath,
      absolutePath,
      exists,
      stats,
      isDirectory,
      shareSourceTarget: getShareSourceTarget(resolved, isDirectory),
    });
  }

  return targets;
};

const getDeleteImpact = async (items = [], options = {}) => {
  const context = {
    user: options.user || null,
    guestSession: options.guestSession || null,
  };
  const targets = await resolveDeleteTargets(items, context);
  const shares = await getSharesForSourceTargets(
    targets.map((target) => target.shareSourceTarget).filter(Boolean)
  );

  return {
    shareCount: shares.length,
    shares,
  };
};

const deleteItems = async (items = [], options = {}) => {
  const results = [];
  const context = {
    user: options.user || null,
    guestSession: options.guestSession || null,
  };
  const targets = await resolveDeleteTargets(items, context);

  for (const target of targets) {
    const { relativePath, absolutePath, exists, stats, isDirectory, shareSourceTarget } = target;
    const affectedShares = shareSourceTarget
      ? await getSharesForSourceTargets([shareSourceTarget])
      : [];

    if (!exists) {
      const deletedShareCount = await deleteSharesByIds(affectedShares.map((share) => share.id));
      results.push({ path: relativePath, status: 'missing' });
      if (deletedShareCount > 0) {
        results[results.length - 1].deletedShareCount = deletedShareCount;
      }
      continue;
    }

    await fs.rm(absolutePath, { recursive: isDirectory || stats.isDirectory(), force: true });
    const deletedShareCount = await deleteSharesByIds(affectedShares.map((share) => share.id));
    results.push({
      path: relativePath,
      status: 'deleted',
      ...(deletedShareCount > 0 ? { deletedShareCount } : {}),
    });
  }

  return results;
};

module.exports = {
  transferItems,
  getDeleteImpact,
  deleteItems,
};
