const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const {
  normalizeRelativePath,
  combineRelativePath,
  findAvailableName,
} = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve, authorizePath } = require('./authorizationService');
const { getSharesForSourceTargets, deleteSharesByIds } = require('./sharesService');
const { removeFavoritesForDeletedPath } = require('./favoritesService');
const folderSizeHooks = require('./folderSizeHooks');

// How often (ms) progress is reported to the caller while bytes stream, so a
// large file emits a steady trickle of updates rather than one per chunk.
const PROGRESS_THROTTLE_MS = 150;

// Recursively sum the byte size of a file or directory subtree. Symlinks count
// as zero (they are recreated, not byte-copied). Best-effort: entries that
// cannot be stat()ed are skipped so a partial tree still yields a usable total.
const computeEntrySize = async (absolutePath, isDirectory) => {
  if (!isDirectory) {
    try {
      const stats = await fs.lstat(absolutePath);
      return stats.isSymbolicLink() ? 0 : stats.size;
    } catch (_) {
      return 0;
    }
  }

  let total = 0;
  const stack = [absolutePath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const stats = await fs.stat(full);
          total += stats.size;
        } catch (_) {
          // Unreadable entry: skip it, keep the total best-effort.
        }
      }
    }
  }
  return total;
};

// Copy a single regular file through streams so bytes can be reported as they
// are written. The source mode is applied at creation to mirror fs.copyFile.
const copyFileWithProgress = (sourcePath, destinationPath, mode, onBytes) =>
  new Promise((resolve, reject) => {
    const readStream = fsSync.createReadStream(sourcePath);
    const writeStream = fsSync.createWriteStream(
      destinationPath,
      mode != null ? { mode } : undefined
    );

    const fail = (error) => {
      readStream.destroy();
      writeStream.destroy();
      reject(error);
    };

    readStream.on('error', fail);
    writeStream.on('error', fail);
    if (typeof onBytes === 'function') {
      readStream.on('data', (chunk) => onBytes(chunk.length));
    }
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });

// Recursively copy a file/dir, reporting copied bytes. Symlinks are recreated.
const copyEntryWithProgress = async (sourcePath, destinationPath, isDirectory, onBytes) => {
  if (!isDirectory) {
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, destinationPath);
      return;
    }
    await copyFileWithProgress(sourcePath, destinationPath, stats.mode, onBytes);
    return;
  }

  await ensureDir(destinationPath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourcePath, entry.name);
    const dest = path.join(destinationPath, entry.name);
    // eslint-disable-next-line no-await-in-loop
    await copyEntryWithProgress(src, dest, entry.isDirectory(), onBytes);
  }
};

// Move an entry, reporting progress. A same-filesystem rename is atomic and
// instant, so the entry's whole size is reported at once; a cross-device move
// (EXDEV) falls back to a byte-tracked copy followed by removal of the source.
const moveEntryWithProgress = async (sourcePath, destinationPath, isDirectory, size, onBytes) => {
  try {
    await fs.rename(sourcePath, destinationPath);
    if (typeof onBytes === 'function' && size > 0) {
      onBytes(size);
    }
  } catch (error) {
    if (error.code === 'EXDEV') {
      await copyEntryWithProgress(sourcePath, destinationPath, isDirectory, onBytes);
      await fs.rm(sourcePath, { recursive: isDirectory, force: true });
    } else {
      throw error;
    }
  }
};

// Phase 1: authorize + resolve every item, stat it, and pre-compute the total
// byte count so the client can render a determinate progress bar. Throws on any
// validation/authorization failure — the route runs this BEFORE it commits to a
// streaming response, so these surface as a normal HTTP error (status + code).
const prepareTransfer = async (items, destination, operation, options = {}) => {
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

  const plans = [];
  let totalBytes = 0;

  for (const item of items) {
    const sourceCombined = combineRelativePath(item.path || '', item.name);
    const {
      allowed: srcAllowed,
      accessInfo: srcAccess,
      resolved: srcResolved,
      // eslint-disable-next-line no-await-in-loop
    } = await authorizeAndResolve(context, sourceCombined, ACTIONS.read);
    if (!srcAllowed || !srcResolved) {
      throw new Error(srcAccess?.denialReason || `Source path not accessible: ${sourceCombined}`);
    }

    const { relativePath: sourceRelative, absolutePath: sourceAbsolute } = srcResolved;

    // eslint-disable-next-line no-await-in-loop
    if (!(await pathExists(sourceAbsolute))) {
      throw new Error(`Source path not found: ${sourceRelative}`);
    }

    if (operation === 'move') {
      const { allowed: deleteAllowed, accessInfo: deleteAccess } =
        // eslint-disable-next-line no-await-in-loop
        await authorizePath(context, sourceCombined, ACTIONS.delete);
      if (!deleteAllowed) {
        throw new Error(deleteAccess?.denialReason || 'Cannot move items from this path.');
      }
    }

    // eslint-disable-next-line no-await-in-loop
    const stats = await fs.stat(sourceAbsolute);
    const isDirectory = stats.isDirectory();
    const sourceParent = normalizeRelativePath(path.dirname(sourceRelative));

    if (operation === 'move' && destinationRelative === sourceParent) {
      plans.push({ sourceRelative, skipped: true });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const size = await computeEntrySize(sourceAbsolute, isDirectory);
    totalBytes += size;

    plans.push({
      sourceAbsolute,
      sourceRelative,
      isDirectory,
      size,
      desiredName: item.newName || item.name,
    });
  }

  return {
    destinationRelative,
    destinationAbsolute,
    plans,
    totalBytes,
    totalItems: plans.filter((plan) => !plan.skipped).length,
  };
};

// Phase 2: perform the copy/move for each prepared plan, reporting progress via
// onProgress({ copiedBytes, totalBytes, currentName }). Runs after the response
// has switched to streaming mode, so an error here is surfaced in the stream.
const executeTransfer = async (prep, operation, onProgress) => {
  const { destinationRelative, destinationAbsolute, plans, totalBytes } = prep;

  await ensureDir(destinationAbsolute);

  const results = [];
  let copiedBytes = 0;
  let lastEmit = 0;
  let currentName = '';

  const emit = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    onProgress({ copiedBytes, totalBytes, currentName });
  };

  const onBytes = (delta) => {
    copiedBytes += delta;
    emit(false);
  };

  for (const plan of plans) {
    if (plan.skipped) {
      results.push({ from: plan.sourceRelative, to: plan.sourceRelative, skipped: true });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const availableName = await findAvailableName(destinationAbsolute, plan.desiredName);
    const targetAbsolute = path.join(destinationAbsolute, availableName);
    const targetRelative = combineRelativePath(destinationRelative, availableName);
    currentName = availableName;
    emit(true);

    if (operation === 'copy') {
      // eslint-disable-next-line no-await-in-loop
      await copyEntryWithProgress(plan.sourceAbsolute, targetAbsolute, plan.isDirectory, onBytes);
      await folderSizeHooks.onEntryCopied(targetAbsolute, {
        isDirectory: plan.isDirectory,
        size: plan.size,
        sourceAbsolutePath: plan.sourceAbsolute,
      });
    } else if (operation === 'move') {
      // eslint-disable-next-line no-await-in-loop
      await moveEntryWithProgress(
        plan.sourceAbsolute,
        targetAbsolute,
        plan.isDirectory,
        plan.size,
        onBytes
      );
      folderSizeHooks.onEntryMoved(plan.sourceAbsolute, targetAbsolute, {
        isDirectory: plan.isDirectory,
        size: plan.size,
      });
    } else {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    results.push({ from: plan.sourceRelative, to: targetRelative });
  }

  // Snap to 100% once every entry is done (covers rounding and any skipped work).
  copiedBytes = totalBytes;
  emit(true);

  return { destination: destinationRelative, items: results };
};

// One-shot API preserved for callers that do not need progress reporting.
const transferItems = async (items, destination, operation, options = {}) => {
  const prep = await prepareTransfer(items, destination, operation, options);
  return executeTransfer(prep, operation, options.onProgress);
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

    const deletedEntryStats = stats || (await fs.stat(absolutePath));
    await fs.rm(absolutePath, {
      recursive: isDirectory || deletedEntryStats.isDirectory(),
      force: true,
    });
    folderSizeHooks.onEntryDeleted(absolutePath, {
      isDirectory: isDirectory || deletedEntryStats.isDirectory(),
      size: deletedEntryStats.size,
    });
    const deletedShareCount = await deleteSharesByIds(affectedShares.map((share) => share.id));
    const removedFavoriteCount = context.user?.id
      ? await removeFavoritesForDeletedPath(context.user.id, relativePath, {
          includeChildren: isDirectory || deletedEntryStats.isDirectory(),
        })
      : 0;
    results.push({
      path: relativePath,
      status: 'deleted',
      ...(deletedShareCount > 0 ? { deletedShareCount } : {}),
      ...(removedFavoriteCount > 0 ? { removedFavoriteCount } : {}),
    });
  }

  return results;
};

module.exports = {
  prepareTransfer,
  executeTransfer,
  transferItems,
  getDeleteImpact,
  deleteItems,
};
