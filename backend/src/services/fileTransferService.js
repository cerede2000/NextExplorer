const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

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
const config = require('../config/index');
const { getDb } = require('./db');
const folderSizeIndex = require('./folderSizeIndex');
const { getVolumeScope } = require('./folderSizeIndexer');

// How often (ms) progress is reported to the caller while bytes stream, so a
// large file emits a steady trickle of updates rather than one per chunk.
const PROGRESS_THROTTLE_MS = 75;
// Node defaults file streams to 64 KiB buffers. That makes a 90 GiB transfer
// cross JavaScript over 1.4 million times. Keep the transfer cancellable, but
// use a bounded 4 MiB buffer to cut that overhead drastically without growing
// memory with the size of the copy.
const COPY_STREAM_HIGH_WATER_MARK = 4 * 1024 * 1024;
const NATIVE_TRANSFER_ENABLED =
  process.platform === 'linux' && process.env.FILE_TRANSFER_ENGINE !== 'stream';
const activeNativeOperations = new Map();
let nextNativeOperationId = 1;

const registerNativeOperation = (type, child, sourcePath, destinationPath = null) => {
  const id = nextNativeOperationId;
  nextNativeOperationId += 1;
  activeNativeOperations.set(id, {
    id,
    type,
    pid: child?.pid || null,
    sourceName: path.basename(sourcePath),
    ...(destinationPath ? { destinationName: path.basename(destinationPath) } : {}),
    startedAt: Date.now(),
  });
  return id;
};

const unregisterNativeOperation = (id) => {
  if (id != null) activeNativeOperations.delete(id);
};

const getDiagnosticsSnapshot = () => {
  const now = Date.now();
  return {
    nativeTransferEnabled: NATIVE_TRANSFER_ENABLED,
    activeNativeOperations: Array.from(activeNativeOperations.values())
      .map((operation) => ({ ...operation, ageMs: now - operation.startedAt }))
      .sort((a, b) => b.ageMs - a.ageMs)
      .slice(0, 5),
  };
};

const createCancellationError = () => {
  const error = new Error('Operation cancelled.');
  error.code = 'OPERATION_CANCELLED';
  return error;
};

const throwIfCancelled = (signal) => {
  if (signal?.aborted) throw createCancellationError();
};

const getFolderSizeLookup = async () => {
  if (!config.folderSize.enabled) return null;
  try {
    return { db: await getDb(), scope: getVolumeScope() };
  } catch (_) {
    // Folder-size indexing is optional. A transfer must never depend on it.
    return null;
  }
};

const indexedDirectorySize = (lookup, absolutePath) => {
  if (!lookup || !folderSizeIndex.isWithinRoot(lookup.scope.root, absolutePath)) return null;
  const entry = folderSizeIndex.getByAbsolutePath(lookup.db, absolutePath);
  return Number.isFinite(entry?.sizeBytes) ? entry.sizeBytes : null;
};

const parseRsyncProgress = (line) => {
  const match = line.match(/^\s*([\d,]+)\s+(\d+)%/);
  if (!match) return null;
  return {
    copiedBytes: Number(match[1].replaceAll(',', '')) || 0,
    percent: Math.min(100, Number(match[2]) || 0),
  };
};

const stopChildProcessGroup = (child, signal) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    child.kill(signal);
  }
};

// rsync keeps file transfer outside the Node event loop while retaining three
// properties the UI needs: safe argv handling, global progress, and immediate
// cancellation. It is used only in the Linux container; local development and
// the explicit FILE_TRANSFER_ENGINE=stream override keep the JS fallback.
const copyWithNativeRsync = (sourcePath, destinationPath, onProgress, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancellationError());
      return;
    }

    const child = spawn(
      'rsync',
      [
        '-a',
        '--no-owner',
        '--no-group',
        '--info=progress2',
        '--outbuf=L',
        '--out-format=%n',
        '--',
        sourcePath,
        destinationPath,
      ],
      {
        detached: true,
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const operationId = registerNativeOperation('rsync', child, sourcePath, destinationPath);
    let output = '';
    let errorOutput = '';
    let settled = false;
    let killTimer = null;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      unregisterNativeOperation(operationId);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const emitOutput = (chunk) => {
      output += chunk.toString();
      const lines = output.split(/[\r\n]/);
      output = lines.pop() || '';
      for (const line of lines) {
        const progress = parseRsyncProgress(line);
        if (progress) onProgress?.(progress);
      }
    };
    const abort = () => {
      stopChildProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => stopChildProcessGroup(child, 'SIGKILL'), 3000);
    };

    child.stdout.on('data', emitOutput);
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (signal?.aborted) return finish(reject, createCancellationError());
      if (code === 0) return finish(resolve);
      const error = new Error(errorOutput.trim() || `Native copy failed with exit code ${code}.`);
      error.code = 'NATIVE_COPY_FAILED';
      return finish(reject, error);
    });
    signal?.addEventListener('abort', abort, { once: true });
  });

const removeWithNativeRm = (absolutePath, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createCancellationError());
    const child = spawn('rm', ['-rf', '--', absolutePath], { detached: true, stdio: 'ignore' });
    const operationId = registerNativeOperation('rm', child, absolutePath);
    let settled = false;
    let killTimer = null;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      unregisterNativeOperation(operationId);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      stopChildProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => stopChildProcessGroup(child, 'SIGKILL'), 3000);
    };
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (signal?.aborted) return finish(reject, createCancellationError());
      if (code === 0) return finish(resolve);
      const error = new Error(`Native deletion failed with exit code ${code}.`);
      error.code = 'NATIVE_DELETE_FAILED';
      return finish(reject, error);
    });
    signal?.addEventListener('abort', abort, { once: true });
  });

// Copy a single regular file through streams so bytes can be reported as they
// are written. The source mode is applied at creation to mirror fs.copyFile.
const copyFileWithProgress = (sourcePath, destinationPath, mode, onBytes, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancellationError());
      return;
    }

    const readStream = fsSync.createReadStream(sourcePath, {
      highWaterMark: COPY_STREAM_HIGH_WATER_MARK,
    });
    const writeStream = fsSync.createWriteStream(
      destinationPath,
      mode != null
        ? { mode, highWaterMark: COPY_STREAM_HIGH_WATER_MARK }
        : { highWaterMark: COPY_STREAM_HIGH_WATER_MARK }
    );

    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => {
      readStream.destroy();
      writeStream.destroy();
      finish(reject, error);
    };
    const abort = () => fail(createCancellationError());

    readStream.on('error', fail);
    writeStream.on('error', fail);
    if (typeof onBytes === 'function') {
      readStream.on('data', (chunk) => onBytes(chunk.length));
    }
    writeStream.on('finish', () => finish(resolve));
    signal?.addEventListener('abort', abort, { once: true });
    readStream.pipe(writeStream);
  });

// Recursively copy a file/dir, reporting copied bytes. It returns the actual
// copied byte count, so folder-size updates never need a second filesystem walk.
const copyEntryWithProgress = async (sourcePath, destinationPath, isDirectory, onBytes, signal) => {
  throwIfCancelled(signal);
  if (NATIVE_TRANSFER_ENABLED) {
    const stats = await fs.lstat(sourcePath);
    if (stats.isDirectory()) {
      // Keep the target name chosen by findAvailableName. rsync copies the
      // directory itself when the source lacks a trailing slash; the explorer
      // contract is to copy its contents into the target directory instead.
      await ensureDir(destinationPath);
      await copyWithNativeRsync(
        `${sourcePath}${path.sep}`,
        `${destinationPath}${path.sep}`,
        onBytes,
        signal
      );
    } else {
      await copyWithNativeRsync(sourcePath, destinationPath, onBytes, signal);
    }
    return stats.isDirectory() ? null : stats.size;
  }
  if (!isDirectory) {
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, destinationPath);
      return 0;
    }
    await copyFileWithProgress(sourcePath, destinationPath, stats.mode, onBytes, signal);
    return stats.size;
  }

  await ensureDir(destinationPath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  let copiedBytes = 0;
  for (const entry of entries) {
    throwIfCancelled(signal);
    const src = path.join(sourcePath, entry.name);
    const dest = path.join(destinationPath, entry.name);
    // eslint-disable-next-line no-await-in-loop
    copiedBytes += await copyEntryWithProgress(src, dest, entry.isDirectory(), onBytes, signal);
  }
  return copiedBytes;
};

// Move an entry, reporting progress. A same-filesystem rename is atomic and
// instant, so the entry's whole size is reported at once; a cross-device move
// (EXDEV) falls back to a byte-tracked copy followed by removal of the source.
const moveEntryWithProgress = async (
  sourcePath,
  destinationPath,
  isDirectory,
  size,
  onBytes,
  signal
) => {
  throwIfCancelled(signal);
  try {
    await fs.rename(sourcePath, destinationPath);
    if (typeof onBytes === 'function' && size > 0) {
      onBytes(size);
    }
    return size;
  } catch (error) {
    if (error.code === 'EXDEV') {
      const copiedBytes = await copyEntryWithProgress(
        sourcePath,
        destinationPath,
        isDirectory,
        onBytes,
        signal
      );
      throwIfCancelled(signal);
      if (NATIVE_TRANSFER_ENABLED) await removeWithNativeRm(sourcePath, signal);
      else await fs.rm(sourcePath, { recursive: isDirectory, force: true });
      return copiedBytes;
    } else {
      throw error;
    }
  }
};

// Phase 1: authorize + resolve every item. Recursive directory-size walks are
// deliberately avoided here: a large copy used to read every source file once
// for progress, then read it all again to copy. Indexed directory sizes give a
// determinate bar in O(1); otherwise the UI uses its indeterminate state while
// the copy starts immediately.
const prepareTransfer = async (items, destination, operation, options = {}) => {
  const { signal } = options;
  throwIfCancelled(signal);
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
  } = await authorizeAndResolve(context, destinationRelative, ACTIONS.read);
  if (!destAllowed || !destResolved) {
    throw new Error(destAccess?.denialReason || 'Destination path is not writable.');
  }

  const { absolutePath: destinationAbsolute } = destResolved;
  const folderSizeLookup = await getFolderSizeLookup();

  const destinationStats = await fs.stat(destinationAbsolute).catch(() => null);
  if (!destinationStats?.isDirectory()) {
    throw new Error('Destination path must be an existing directory.');
  }

  const plans = [];
  let totalBytes = 0;
  let hasUnknownSize = false;

  for (const item of items) {
    throwIfCancelled(signal);
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

    if (
      isDirectory &&
      (destinationAbsolute === sourceAbsolute ||
        destinationAbsolute.startsWith(`${sourceAbsolute}${path.sep}`))
    ) {
      throw new Error('Cannot copy or move a folder into itself.');
    }

    if (operation === 'move' && destinationRelative === sourceParent) {
      plans.push({ sourceRelative, skipped: true });
      continue;
    }

    const destinationAction = isDirectory ? ACTIONS.createFolder : ACTIONS.createFile;
    // eslint-disable-next-line no-await-in-loop
    const { allowed: createAllowed, accessInfo: createAccess } = await authorizePath(
      context,
      destinationRelative,
      destinationAction
    );
    if (!createAllowed) {
      throw new Error(createAccess?.denialReason || 'Cannot create items in the destination path.');
    }

    // A copied directory may contain files as well as folders. Do not let the
    // directory permission become a way around the file creation restriction.
    if (isDirectory) {
      // eslint-disable-next-line no-await-in-loop
      const { allowed: filesAllowed, accessInfo: filesAccess } = await authorizePath(
        context,
        destinationRelative,
        ACTIONS.createFile
      );
      if (!filesAllowed) {
        throw new Error(
          filesAccess?.denialReason || 'Cannot create files in the destination path.'
        );
      }
    }

    const size = isDirectory ? indexedDirectorySize(folderSizeLookup, sourceAbsolute) : stats.size;
    if (Number.isFinite(size)) totalBytes += size;
    else hasUnknownSize = true;

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
    totalBytes: hasUnknownSize ? 0 : totalBytes,
    totalItems: plans.filter((plan) => !plan.skipped).length,
  };
};

// Phase 2: perform the copy/move for each prepared plan, reporting progress via
// onProgress({ copiedBytes, totalBytes, currentName }). Runs after the response
// has switched to streaming mode, so an error here is surfaced in the stream.
const executeTransfer = async (prep, operation, onProgress, options = {}) => {
  const { destinationRelative, destinationAbsolute, plans, totalBytes } = prep;
  const { signal } = options;

  throwIfCancelled(signal);
  const destinationStats = await fs.stat(destinationAbsolute).catch(() => null);
  if (!destinationStats?.isDirectory()) {
    throw new Error('Destination path no longer exists.');
  }

  const results = [];
  let copiedBytes = 0;
  let lastEmit = 0;
  let currentName = '';
  let nativePercent = null;
  let activeTarget = null;
  const transferredDirectories = [];

  const emit = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    onProgress({
      copiedBytes,
      totalBytes,
      currentName,
      ...(nativePercent != null ? { percent: nativePercent } : {}),
    });
  };

  const onBytes = (delta) => {
    const wasAtStart = copiedBytes === 0;
    copiedBytes += delta;
    // Show the first byte immediately, then throttle the steady stream of
    // updates. Besides making the UI feel responsive, this lets an operation
    // become cancellable as soon as data starts moving.
    emit(wasAtStart);
  };

  try {
    for (const plan of plans) {
      throwIfCancelled(signal);
      if (plan.skipped) {
        results.push({ from: plan.sourceRelative, to: plan.sourceRelative, skipped: true });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const availableName = await findAvailableName(destinationAbsolute, plan.desiredName);
      const targetAbsolute = path.join(destinationAbsolute, availableName);
      const targetRelative = combineRelativePath(destinationRelative, availableName);
      activeTarget = { absolutePath: targetAbsolute, isDirectory: plan.isDirectory };
      currentName = availableName;
      nativePercent = null;
      emit(true);

      if (plan.isDirectory) {
        // Reserve the index entry before rsync creates its first child, so an
        // on-view refresh cannot publish a size for a partial transfer.
        // eslint-disable-next-line no-await-in-loop
        await folderSizeHooks.beginDirectoryTransfer(targetAbsolute);
      }

      const copiedBeforePlan = copiedBytes;
      const onCopyProgress = (progress) => {
        if (typeof progress === 'number') {
          onBytes(progress);
          return;
        }
        nativePercent = Number.isFinite(progress?.percent) ? progress.percent : null;
        if (Number.isFinite(plan.size) && nativePercent != null) {
          copiedBytes = copiedBeforePlan + (plan.size * nativePercent) / 100;
        }
        emit(true);
      };

      if (operation === 'copy') {
        // eslint-disable-next-line no-await-in-loop
        const copiedSize = await copyEntryWithProgress(
          plan.sourceAbsolute,
          targetAbsolute,
          plan.isDirectory,
          onCopyProgress,
          signal
        );
        await folderSizeHooks.onEntryCopied(targetAbsolute, {
          isDirectory: plan.isDirectory,
          size: copiedSize ?? plan.size,
          sourceAbsolutePath: plan.sourceAbsolute,
          directoryTransferPrepared: plan.isDirectory,
        });
      } else if (operation === 'move') {
        // eslint-disable-next-line no-await-in-loop
        const movedSize = await moveEntryWithProgress(
          plan.sourceAbsolute,
          targetAbsolute,
          plan.isDirectory,
          plan.size,
          onCopyProgress,
          signal
        );
        await folderSizeHooks.onEntryMoved(plan.sourceAbsolute, targetAbsolute, {
          isDirectory: plan.isDirectory,
          size: movedSize ?? plan.size,
          directoryTransferPrepared: plan.isDirectory,
        });
      } else {
        throw new Error(`Unsupported operation: ${operation}`);
      }

      if (plan.isDirectory) transferredDirectories.push(targetAbsolute);

      results.push({ from: plan.sourceRelative, to: targetRelative });
      activeTarget = null;
    }

    // Snap to 100% once every entry is done when the total was known before
    // starting. Unknown directory totals intentionally stay indeterminate.
    if (totalBytes > 0) copiedBytes = totalBytes;
    emit(true);

    // Rebuild copied/moved directory indexes only after the complete operation
    // has finished writing. This avoids expensive disk scans competing with the
    // transfer and makes the eventual size authoritative.
    folderSizeHooks.refreshTransferredDirectories(transferredDirectories);

    return { destination: destinationRelative, items: results };
  } catch (error) {
    // A cancellation can interrupt a recursive copy part-way through an entry.
    // Remove only that incomplete destination; already completed entries remain
    // intact, which is the least surprising and safest cancellation semantics.
    if (error?.code === 'OPERATION_CANCELLED' && activeTarget) {
      await fs.rm(activeTarget.absolutePath, {
        recursive: activeTarget.isDirectory,
        force: true,
      });
      if (activeTarget.isDirectory) {
        await folderSizeHooks.cancelDirectoryTransfer(activeTarget.absolutePath);
      }
    }
    if (error?.code !== 'OPERATION_CANCELLED' && activeTarget?.isDirectory) {
      // An unexpected I/O failure can leave an inspectable partial directory.
      // Release its transfer lock and index what remains instead of permanently
      // suppressing size refreshes until the process restarts.
      folderSizeHooks.refreshTransferredDirectories([activeTarget.absolutePath]);
    }
    // Completed entries remain after a cancellation and still need their final
    // directory-size scan. The active partial target was removed above.
    folderSizeHooks.refreshTransferredDirectories(transferredDirectories);
    throw error;
  }
};

// One-shot API preserved for callers that do not need progress reporting.
const transferItems = async (items, destination, operation, options = {}) => {
  const prep = await prepareTransfer(items, destination, operation, options);
  return executeTransfer(prep, operation, options.onProgress, { signal: options.signal });
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

const resolveDeleteTargets = async (items = [], context, options = {}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required.');
  }

  const includeStats = options.includeStats !== false;
  const includeShareDescendants = Boolean(options.includeShareDescendants);
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
    const exists = includeStats ? await pathExists(absolutePath) : null;
    const stats = includeStats && exists ? await fs.stat(absolutePath) : null;
    const isDirectory = stats ? stats.isDirectory() : item?.kind === 'directory';

    targets.push({
      item,
      relativePath,
      absolutePath,
      exists,
      stats,
      isDirectory,
      // The delete-impact endpoint must include shares nested below a folder,
      // but it does not need a filesystem stat just to determine that. Looking
      // below a regular file is harmless (there cannot be matching children),
      // and avoids an avoidable disk round trip before every confirmation.
      shareSourceTarget: getShareSourceTarget(
        resolved,
        includeShareDescendants ? true : isDirectory
      ),
    });
  }

  return targets;
};

const getDeleteImpact = async (items = [], options = {}) => {
  const context = {
    user: options.user || null,
    guestSession: options.guestSession || null,
  };
  const targets = await resolveDeleteTargets(items, context, {
    includeStats: false,
    includeShareDescendants: true,
  });
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

  let completedItems = 0;
  for (const target of targets) {
    throwIfCancelled(options.signal);
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
      completedItems += 1;
      options.onProgress?.({
        completedItems,
        totalItems: targets.length,
        currentName: target.item?.name || relativePath,
        percent: Math.round((completedItems / targets.length) * 100),
      });
      continue;
    }

    const deletedEntryStats = stats || (await fs.stat(absolutePath));
    if (NATIVE_TRANSFER_ENABLED) {
      await removeWithNativeRm(absolutePath, options.signal);
    } else {
      await fs.rm(absolutePath, {
        recursive: isDirectory || deletedEntryStats.isDirectory(),
        force: true,
      });
    }
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
    completedItems += 1;
    options.onProgress?.({
      completedItems,
      totalItems: targets.length,
      currentName: target.item?.name || relativePath,
      percent: Math.round((completedItems / targets.length) * 100),
    });
  }

  return results;
};

module.exports = {
  prepareTransfer,
  executeTransfer,
  createCancellationError,
  transferItems,
  getDeleteImpact,
  deleteItems,
  getDiagnosticsSnapshot,
};
