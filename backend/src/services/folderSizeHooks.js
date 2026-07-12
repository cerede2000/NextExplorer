/**
 * Folder size index — write hooks.
 *
 * NextExplorer's own write operations (upload, delete, move, copy, folder
 * creation) already know the exact byte impact of what they did, so they update
 * the folder_size_index directly with a precise, ancestor-propagating delta —
 * no extra filesystem traversal, no synchronous `du`. This is the fast path;
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

const isEnabled = () => config.folderSize.enabled;

const withIndex = async (fn) => {
  if (!isEnabled()) return;
  try {
    const db = await getDb();
    const scope = getVolumeScope();
    fn(db, scope);
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
      folderSizeIndex.reparentSubtree(db, scope, sourceAbsolutePath, targetAbsolutePath);
    }
    folderSizeIndex.applyDelta(db, scope, path.dirname(targetAbsolutePath), bytes, {
      entryDelta: 1,
    });
  });

/**
 * An entry has been copied to `targetAbsolutePath`. The destination gains the
 * copied bytes; for a copied directory its inner folders are (re)discovered by
 * the watcher / reconciliation — the top entry is created here as a placeholder.
 */
const onEntryCopied = (targetAbsolutePath, meta = {}) =>
  withIndex((db, scope) => {
    const bytes = meta.isDirectory
      ? sizeOfMoved(db, scope, meta.sourceAbsolutePath, meta)
      : Number(meta.size) || 0;
    folderSizeIndex.applyDelta(db, scope, path.dirname(targetAbsolutePath), bytes, {
      entryDelta: 1,
    });
  });

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
  onFolderCreated,
  onEntryDeleted,
  onEntryMoved,
  onEntryCopied,
  onEntryRenamed,
};
