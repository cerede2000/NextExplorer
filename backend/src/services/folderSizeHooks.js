/**
 * Folder size index — write hooks.
 *
 * NextExplorer's own write operations (upload, delete, move, copy, folder
 * creation) already know the exact byte impact of files, so they update the
 * folder_size_index directly with a precise, ancestor-propagating delta — no
 * extra filesystem traversal, no synchronous `du`. Directory transfers are
 * intentionally different: an authoritative subtree scan runs after the whole
 * operation completes, rather than trusting stale copied index metadata.
 * external writes (other Samba/NFS clients) are picked up separately by the
 * watcher and the periodic reconciliation.
 *
 * Every hook is best-effort: it is gated on the feature being enabled, resolves
 * the shared main-thread database connection, and swallows/logs any error so an
 * indexing hiccup can never fail (or slow down materially) the user's actual
 * file operation. All writes are tiny synchronous SQLite transactions.
 */
const path = require('path');

const config = require('../config/index');
const logger = require('../utils/logger');
const { getDb } = require('./db');
const folderSizeIndex = require('./folderSizeIndex');
const { getVolumeScope } = require('./folderSizeIndexer');
const folderSizeManager = require('./folderSizeManager');

const isEnabled = () => config.folderSize.enabled;

const withIndex = async (fn) => {
  if (!isEnabled()) return;
  try {
    const db = await getDb();
    const scope = getVolumeScope();
    return await fn(db, scope);
  } catch (err) {
    logger.debug({ err, component: 'folderSizeIndexer' }, 'Folder size hook failed (non-fatal)');
  }
};

/** A file has been created/written at `absolutePath` with `size` bytes. */
const onFileWritten = (absolutePath, size) =>
  withIndex((db, scope) => {
    folderSizeIndex.applyDelta(db, scope, path.dirname(absolutePath), Number(size) || 0, {
      entryDelta: 1,
    });
  });

/** A file was replaced in place; only its byte delta changes the index. */
const onFileReplaced = (absolutePath, previousSize, size) =>
  withIndex((db, scope) => {
    folderSizeIndex.applyDelta(
      db,
      scope,
      path.dirname(absolutePath),
      (Number(size) || 0) - (Number(previousSize) || 0)
    );
  });

/** An empty folder has been created at `absolutePath`. */
const onFolderCreated = (absolutePath) =>
  withIndex((db, scope) => {
    folderSizeIndex.upsertScanEntry(db, scope, {
      absolutePath,
      sizeBytes: 0,
      entryCount: 0,
      lastFullScanAt: new Date().toISOString(),
    });
    folderSizeIndex.applyDelta(db, scope, path.dirname(absolutePath), 0, { entryDelta: 1 });
  });

/**
 * A complete directory tree was created by an application operation. The
 * manager scans this tree alone and applies one precise delta to its parent.
 */
const onDirectoryTreeCreated = async (absolutePath) => {
  if (!isEnabled()) return null;
  try {
    return await folderSizeManager.refreshSubtree(absolutePath);
  } catch (err) {
    logger.debug(
      { err, component: 'folderSizeIndexer' },
      'Folder subtree index refresh failed (non-fatal)'
    );
    return null;
  }
};

/**
 * An entry has been deleted. For a file the size is known; for a directory the
 * recursive size comes from the index (its subtree is dropped and removed from
 * the ancestors).
 */
const onEntryDeleted = (absolutePath, { isDirectory, size } = {}) =>
  withIndex((db, scope) => {
    if (isDirectory) {
      const removed = folderSizeIndex.getByAbsolutePath(db, absolutePath);
      const removedSize = removed ? removed.sizeBytes : 0;
      folderSizeIndex.removeSubtree(db, scope, absolutePath);
      if (folderSizeIndex.isWithinRoot(scope.root, absolutePath) && absolutePath !== scope.root) {
        folderSizeIndex.applyDelta(db, scope, path.dirname(absolutePath), -removedSize, {
          entryDelta: -1,
        });
      }
    } else {
      folderSizeIndex.applyDelta(db, scope, path.dirname(absolutePath), -(Number(size) || 0), {
        entryDelta: -1,
      });
    }
  });

const sizeOfMoved = (db, scope, sourceAbsolutePath, { isDirectory, size }) => {
  if (!isDirectory) return Number(size) || 0;
  const entry = folderSizeIndex.getByAbsolutePath(db, sourceAbsolutePath);
  return entry ? entry.sizeBytes : 0;
};

/** An entry has been moved from `sourceAbsolutePath` to `targetAbsolutePath`. */
const onEntryMoved = (sourceAbsolutePath, targetAbsolutePath, meta = {}) =>
  withIndex((db, scope) => {
    const bytes = sizeOfMoved(db, scope, sourceAbsolutePath, meta);
    folderSizeIndex.applyDelta(db, scope, path.dirname(sourceAbsolutePath), -bytes, {
      entryDelta: -1,
    });
    if (meta.isDirectory) {
      // A cached subtree can be incomplete or out of date when the directory
      // originated outside NextExplorer. Drop it and let the post-operation
      // authoritative scan rebuild the destination instead of moving bad data.
      folderSizeIndex.removeSubtree(db, scope, sourceAbsolutePath);
      if (folderSizeIndex.isWithinRoot(scope.root, targetAbsolutePath)) {
        folderSizeIndex.upsertPendingDirectoryEntry(db, scope, {
          absolutePath: targetAbsolutePath,
          sizeBytes: 0,
          entryCount: 0,
        });
        folderSizeIndex.applyDelta(db, scope, path.dirname(targetAbsolutePath), 0, {
          entryDelta: 1,
        });
      }
      return;
    }
    folderSizeIndex.applyDelta(db, scope, path.dirname(targetAbsolutePath), bytes, {
      entryDelta: 1,
    });
  });

/**
 * An entry has been copied to `targetAbsolutePath`. The destination gains the
 * copied bytes. A copied directory is marked pending so a single authoritative
 * scan can rebuild it once the complete transfer has finished. Cloning the
 * source index is deliberately avoided: source rows may be stale or incomplete.
 */
const onEntryCopied = async (targetAbsolutePath, meta = {}) => {
  return withIndex((db, scope) => {
    if (meta.isDirectory) {
      if (!folderSizeIndex.isWithinRoot(scope.root, targetAbsolutePath)) return;
      folderSizeIndex.upsertPendingDirectoryEntry(db, scope, {
        absolutePath: targetAbsolutePath,
        sizeBytes: 0,
        entryCount: 0,
      });
      folderSizeIndex.applyDelta(db, scope, path.dirname(targetAbsolutePath), 0, {
        entryDelta: 1,
      });
      return;
    }

    folderSizeIndex.applyDelta(
      db,
      scope,
      path.dirname(targetAbsolutePath),
      Number(meta.size) || 0,
      {
        entryDelta: 1,
      }
    );
  });
};

/**
 * Queue authoritative scans once a transfer has settled. The manager deduplicates
 * paths and serializes scans, so a large multi-item copy never competes with its
 * own I/O while it is still writing files.
 */
const refreshTransferredDirectories = (absolutePaths = []) => {
  if (!isEnabled()) return;
  const uniquePaths = [...new Set(absolutePaths.filter(Boolean))];
  for (const absolutePath of uniquePaths) {
    folderSizeManager.refreshSubtree(absolutePath).catch((err) => {
      logger.debug(
        { err, component: 'folderSizeIndexer', path: absolutePath },
        'Transferred directory refresh failed (non-fatal)'
      );
    });
  }
};

/**
 * An entry has been renamed in place (same parent directory). Bytes and parent
 * are unchanged, so there is no delta — but an indexed directory's subtree keys
 * must follow the new name. Files are not individually indexed, so this is a
 * no-op for them.
 */
const onEntryRenamed = (sourceAbsolutePath, targetAbsolutePath) =>
  withIndex((db, scope) => {
    const entry = folderSizeIndex.getByAbsolutePath(db, sourceAbsolutePath);
    if (entry) folderSizeIndex.reparentSubtree(db, scope, sourceAbsolutePath, targetAbsolutePath);
  });

module.exports = {
  onFileWritten,
  onFileReplaced,
  onFolderCreated,
  onDirectoryTreeCreated,
  onEntryDeleted,
  onEntryMoved,
  onEntryCopied,
  refreshTransferredDirectories,
  onEntryRenamed,
};
