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
const trash = require('./trash');
const { getTrashSettings } = require('./trash/settings');
const favoritesService = require('./favoritesService');

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

/**
 * Copy an entry recursively, reporting the bytes copied so far and stopping when
 * the signal aborts. A symbolic link is copied as a link, keeping its text; a
 * file is copied and its size reported; a folder is created and its entries
 * copied in turn. Answers the total bytes copied. Used by the trash to restore
 * across disks with real progress.
 */
const copyEntryWithProgress = async (sourcePath, destinationPath, isDirectory, onBytes, signal) => {
  if (signal?.aborted) throw createCancellationError();
  const stats = await fs.lstat(sourcePath);
  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    return 0;
  }
  if (!stats.isDirectory() && !isDirectory) {
    await fs.copyFile(sourcePath, destinationPath);
    onBytes?.(stats.size);
    return stats.size;
  }

  await ensureDir(destinationPath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  let copiedBytes = 0;
  for (const entry of entries) {
    if (signal?.aborted) throw createCancellationError();
    const src = path.join(sourcePath, entry.name);
    const dest = path.join(destinationPath, entry.name);
    // eslint-disable-next-line no-await-in-loop
    copiedBytes += await copyEntryWithProgress(src, dest, entry.isDirectory(), onBytes, signal);
  }
  return copiedBytes;
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
      // Where it was reached through, and the share when it was one: the trash
      // records whose folder or share a deletion came from.
      space: resolved.space,
      shareInfo: resolved.shareInfo || null,
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
  // Into the trash or gone for good, per item, so the confirmation can say
  // which before anyone presses the button — and, for each, how many share
  // links it carries: switched off and kept in the trash, or deleted with it.
  const trashPlan = await trash.describeTargets(targets);
  trashPlan.items = await Promise.all(
    trashPlan.items.map(async (entry, index) => {
      const { shareSourceTarget } = targets[index] || {};
      const linked = shareSourceTarget ? await getSharesForSourceTargets([shareSourceTarget]) : [];
      return { ...entry, shareCount: linked.length };
    })
  );

  return {
    shareCount: shares.length,
    shares,
    trash: trashPlan,
  };
};

const createCancellationError = () => {
  const error = new Error('Operation cancelled.');
  error.code = 'OPERATION_CANCELLED';
  return error;
};

const deleteItems = async (items = [], options = {}) => {
  const results = [];
  const context = {
    user: options.user || null,
    guestSession: options.guestSession || null,
  };
  // The route may have resolved (and authorized) the targets already, so the
  // work is not repeated just to stream the result.
  const targets = options.targets || (await resolveDeleteTargets(items, context));

  // Into the trash unless the caller asked for a permanent deletion, or the
  // trash is switched off. Asked once for the whole selection.
  const trashSettings = options.permanent === true ? null : await getTrashSettings();
  const useTrash = Boolean(trashSettings?.enabled);
  const budgetFor = useTrash ? trash.budgetResolver(trashSettings) : null;

  let completedItems = 0;
  const reportProgress = (target, relativePath) => {
    completedItems += 1;
    options.onProgress?.({
      completedItems,
      totalItems: targets.length,
      currentName: target.item?.name || relativePath,
      percent: Math.round((completedItems / targets.length) * 100),
    });
  };

  for (const target of targets) {
    if (options.signal?.aborted) throw createCancellationError();
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
      reportProgress(target, relativePath);
      continue;
    }

    let trashItemId = null;
    if (useTrash) {
      const outcome = await trash.trashTarget(target, context, { budgetFor });
      if (outcome.status === 'missing') {
        results.push({ path: relativePath, status: 'missing' });
        reportProgress(target, relativePath);
        continue;
      }
      if (outcome.status !== 'trashed') {
        // Never turned into a permanent deletion here: the entry stays where it
        // is, and the person is asked whether to delete it for good.
        results.push({
          path: relativePath,
          status: 'kept',
          reason: outcome.reason,
          ...(outcome.reason === 'too-large'
            ? { size: outcome.size, budgetBytes: outcome.budgetBytes }
            : {}),
        });
        reportProgress(target, relativePath);
        continue;
      }
      trashItemId = outcome.item.id;
    } else {
      await fs.rm(absolutePath, { recursive: isDirectory || stats.isDirectory(), force: true });
    }
    // In the trash, a share is switched off but kept with the item, so a restore
    // can bring it back; deleted for good, it goes for good.
    if (trashItemId) {
      await trash.suspendShares(
        trashItemId,
        shareSourceTarget,
        affectedShares.map((share) => share.id)
      );
    }
    const deletedShareCount = await deleteSharesByIds(affectedShares.map((share) => share.id));
    // Favorites the deleter had on what just went away: a favorite pointing at
    // nothing is a dead end. Best-effort, and only for a signed-in account.
    let removedFavoriteCount = 0;
    if (context.user?.id) {
      try {
        removedFavoriteCount = await favoritesService.removeFavoritesForDeletedPath(
          context.user.id,
          relativePath,
          { includeChildren: isDirectory || stats.isDirectory() }
        );
      } catch {
        // A favorites cleanup must never fail a deletion.
      }
    }
    results.push({
      path: relativePath,
      status: trashItemId ? 'trashed' : 'deleted',
      ...(trashItemId ? { trashItemId } : {}),
      ...(deletedShareCount > 0 ? { deletedShareCount } : {}),
      ...(removedFavoriteCount > 0 ? { removedFavoriteCount } : {}),
    });
    reportProgress(target, relativePath);
  }

  return results;
};

module.exports = {
  transferItems,
  getDeleteImpact,
  resolveDeleteTargets,
  deleteItems,
  // Where a path is, as share links name it: the trash points a restored share
  // at the place its content went back to.
  getShareSourceTarget,
  // The trash restores across disks with a copy that reports progress, copies a
  // link as a link and is cancellable.
  copyEntryWithProgress,
};
