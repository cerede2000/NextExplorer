const path = require('path');
const fs = require('fs/promises');

const { excludedFiles, extensions, hiddenFiles } = require('../config/index');
const { combineRelativePath, resolveLogicalPath } = require('../utils/pathUtils');
const { getAccessInfo } = require('./accessManager');
const { createPermissionResolver } = require('./accessControlService');
const logger = require('../utils/logger');
const onlyofficeActivity = require('./onlyofficeActivityService');

const LIST_DIRECTORY_CONCURRENCY = 64;

const previewable = new Set([
  ...extensions.images,
  ...(extensions.rawImages || []),
  ...extensions.videos,
  ...(extensions.documents || []),
]);

const toKind = (stats, name) => {
  if (stats.isDirectory()) return 'directory';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return 'unknown';
  return ext.length > 10 ? 'unknown' : ext;
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
};

/**
 * Whether a symbolic link leads out of the space it sits in.
 *
 * Asked of the same resolver every operation goes through, so the listing and
 * the operations cannot disagree: a link the resolver refuses is one nothing
 * can be done through. A link it cannot follow at all — to nothing — is left to
 * the stat that comes next, which skips it as before.
 */
const linkLeavesTheSpace = async (context, logicalPath, access) => {
  try {
    await resolveLogicalPath(logicalPath, {
      user: context?.user || null,
      guestSession: context?.guestSession || null,
      share: access?.share || null,
      userVolume: access?.userVolume || null,
    });
    return false;
  } catch (error) {
    return error?.statusCode === 403;
  }
};

/**
 * List a directory and filter out entries that the caller cannot access.
 *
 * - Uses accessManager for per-child visibility (covers shares + user volumes + hidden rules).
 * - Does not throw for child-level failures; unreadable / inaccessible children are skipped.
 * - A symbolic link that leads out of the space is listed as what it is — a link,
 *   marked `link: 'outside'` — and never followed. It used to be described by
 *   what it points at: the size and type of a file outside the volume, on a row
 *   every action then refused with "Resolved path is outside the configured
 *   volume root", with nothing on screen to say why.
 */
const listDirectoryItems = async ({
  absoluteDir,
  parentLogicalPath,
  context,
  thumbsEnabled,
  includeHiddenFiles = false,
  itemExtras = null,
  permissionRules = null,
  shareCache = null,
  userVolumeCache = null,
}) => {
  const permissionResolver =
    Array.isArray(permissionRules) && permissionRules.length
      ? createPermissionResolver(permissionRules)
      : null;

  const accessOptions = {
    ...(permissionResolver ? { permissionResolver } : null),
    ...(shareCache instanceof Map ? { shareCache } : null),
    ...(userVolumeCache instanceof Map ? { userVolumeCache } : null),
  };

  const entries = await fs.readdir(absoluteDir);

  const filtered = entries
    .filter((name) => !excludedFiles.includes(name))
    .filter((name) => includeHiddenFiles || !hiddenFiles.isHiddenName(name));

  const items = await mapWithConcurrency(filtered, LIST_DIRECTORY_CONCURRENCY, async (name) => {
    const filePath = path.join(absoluteDir, name);
    const logicalChildPath = combineRelativePath(parentLogicalPath || '', name);

    let stats;
    let entry;
    try {
      entry = await fs.lstat(filePath);
      stats = entry.isSymbolicLink() ? null : entry;
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOENT', 'ELOOP'].includes(err?.code)) {
        logger.warn({ filePath, err }, 'Skipping unreadable entry');
        return null;
      }
      throw err;
    }

    const childAccess = await getAccessInfo(context, logicalChildPath, accessOptions);
    if (!childAccess?.canAccess) {
      return null;
    }

    if (!stats) {
      if (await linkLeavesTheSpace(context, logicalChildPath, childAccess)) {
        return {
          name,
          path: parentLogicalPath,
          dateModified: entry.mtime,
          size: null,
          kind: toKind(entry, name),
          link: 'outside',
        };
      }
      try {
        stats = await fs.stat(filePath);
      } catch (err) {
        if (['EPERM', 'EACCES', 'ENOENT', 'ELOOP'].includes(err?.code)) {
          logger.warn({ filePath, err }, 'Skipping unreadable entry');
          return null;
        }
        throw err;
      }
    }

    const kind = toKind(stats, name);
    const item = {
      name,
      path: parentLogicalPath,
      dateModified: stats.mtime,
      size: stats.size,
      kind,
    };

    if (stats.isFile()) {
      const activity = onlyofficeActivity.get(filePath);
      if (activity?.active) item.onlyofficeActivity = activity;
    }

    if (thumbsEnabled && stats.isFile() && kind !== 'pdf' && previewable.has(kind.toLowerCase())) {
      item.supportsThumbnail = true;
    }

    if (typeof itemExtras === 'function') {
      Object.assign(item, itemExtras({ name, stats, kind, access: childAccess }) || {});
    }

    return item;
  });

  return items.filter(Boolean);
};

module.exports = {
  listDirectoryItems,
};
