const path = require('path');
const fs = require('fs/promises');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const {
  normalizeRelativePath,
  combineRelativePath,
  findAvailableName,
} = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve, authorizePath } = require('./authorizationService');
const { getSharesForSourceTargets, deleteSharesByIds } = require('./sharesService');

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

const moveEntry = async (sourcePath, destinationPath, isDirectory) => {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code === 'EXDEV') {
      await copyEntry(sourcePath, destinationPath, isDirectory);
      await fs.rm(sourcePath, { recursive: isDirectory, force: true });
    } else {
      throw error;
    }
  }
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

    const desiredName = item.newName || item.name;
    const availableName = await findAvailableName(destinationAbsolute, desiredName);
    const targetAbsolute = path.join(destinationAbsolute, availableName);
    const targetRelative = combineRelativePath(destinationRelative, availableName);

    if (operation === 'copy') {
      await copyEntry(sourceAbsolute, targetAbsolute, stats.isDirectory());
    } else if (operation === 'move') {
      await moveEntry(sourceAbsolute, targetAbsolute, stats.isDirectory());
    } else {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    results.push({ from: sourceRelative, to: targetRelative });
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
