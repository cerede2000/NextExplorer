const path = require('path');
const fs = require('fs/promises');

const { excludedFiles, extensions, hiddenFiles } = require('../config/index');
const { combineRelativePath, resolveLogicalPath } = require('../utils/pathUtils');
const bytePath = require('../utils/bytePath');
const { encodeName, displayName, needsEncoding } = require('../utils/byteName');
const { getAccessInfo } = require('./accessManager');
const { createPermissionResolver } = require('./accessControlService');
const { createUnreachableTally } = require('../utils/unreachableEntries');
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
 * - Answers `{ items, unreadable }`: an entry nobody can reach is left off the
 *   list and counted, because a folder that quietly shows one row fewer than it
 *   holds is how a name whose bytes do not decode as UTF-8 went unnoticed until
 *   a download of the folder answered 500. An entry an access rule hides is not
 *   counted — saying so would tell the caller what it is not allowed to know.
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
  access = null,
  shareCache = null,
  userVolumeCache = null,
}) => {
  // The whole section, never the bare list: a caller handing over the rules
  // alone would silently drop the setting that says whom they hold.
  const permissionResolver =
    Array.isArray(access?.rules) && access.rules.length ? createPermissionResolver(access) : null;

  const accessOptions = {
    ...(permissionResolver ? { permissionResolver } : null),
    ...(shareCache instanceof Map ? { shareCache } : null),
    ...(userVolumeCache instanceof Map ? { userVolumeCache } : null),
  };

  /**
   * Which entries carry the read-only mark: the ones a rule holds this caller
   * to, and only where that starts.
   *
   * A rule was invisible until something was attempted in the folder it covers,
   * and on an account no rule held it was never refused at all
   * (nxzai/NextExplorer#407). The mark says it up front — but a recursive rule
   * covers everything below it, and a lock on every row inside a folder that is
   * already read-only says nothing the row above did not. So it is drawn where
   * the restriction begins: on the entry whose folder is not itself read-only.
   *
   * Asked of the rules alone, not of the whole access decision: this mark is
   * about a rule, and a volume read-only for another reason carries its own.
   */
  const isAdmin = Boolean(context?.user?.roles?.includes?.('admin'));
  const ruleSays = (logicalPath) =>
    permissionResolver ? permissionResolver(logicalPath || '', { isAdmin }) : 'rw';
  const insideReadOnly = ruleSays(parentLogicalPath) === 'ro';

  /**
   * Read as bytes, which is what a name is.
   *
   * `readdir` without this answers text: Node decodes each name as UTF-8 and
   * puts U+FFFD where it cannot, and the path built back from that name leads
   * nowhere — so the entry was listed, found unreachable, and left off. Read
   * as bytes, the path is built from the bytes the disk holds and the entry is
   * an entry like any other.
   *
   * Each name is then carried twice: `name` as it reads, and `pathName` as a
   * path segment. They are the same string for every name that is valid UTF-8,
   * which is every name on every volume anybody has looked at, so the rows are
   * exactly what they were.
   */
  const entries = (await fs.readdir(absoluteDir, { encoding: 'buffer' })).map((bytes) => ({
    bytes,
    name: displayName(bytes),
    pathName: encodeName(bytes),
    written: needsEncoding(bytes),
  }));
  const unreachable = createUnreachableTally();

  const filtered = entries
    .filter(({ name }) => !excludedFiles.includes(name))
    .filter(({ name }) => includeHiddenFiles || !hiddenFiles.isHiddenName(name));

  const items = await mapWithConcurrency(
    filtered,
    LIST_DIRECTORY_CONCURRENCY,
    async ({ bytes, name, pathName, written }) => {
      const filePath = bytePath.join(absoluteDir, bytes);
      const logicalChildPath = combineRelativePath(parentLogicalPath || '', pathName);

      let stats;
      let entry;
      try {
        entry = await fs.lstat(filePath);
        stats = entry.isSymbolicLink() ? null : entry;
      } catch (err) {
        logger.warn({ filePath, err }, 'Skipping unreadable entry');
        unreachable.noteOrThrow(filePath, err);
        return null;
      }

      const childAccess = await getAccessInfo(context, logicalChildPath, accessOptions);
      if (!childAccess?.canAccess) {
        return null;
      }

      /**
       * How to address this entry, when that is not simply its name.
       *
       * Left out for every name that is valid UTF-8, so the rows are byte for
       * byte what they were and nothing reading them has to know this field
       * exists. Present when the name had to be written down, and then it is
       * what every path the client builds has to use: `name` is for the eye and
       * holds U+FFFD, which names nothing.
       */
      const addressing = written ? { pathName } : null;

      if (!stats) {
        if (await linkLeavesTheSpace(context, logicalChildPath, childAccess)) {
          return {
            name,
            ...addressing,
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
          logger.warn({ filePath, err }, 'Skipping unreadable entry');
          unreachable.noteOrThrow(filePath, err);
          return null;
        }
      }

      const kind = toKind(stats, name);
      const item = {
        name,
        ...addressing,
        path: parentLogicalPath,
        dateModified: stats.mtime,
        size: stats.size,
        kind,
      };

      if (stats.isFile()) {
        const activity = onlyofficeActivity.get(filePath);
        if (activity?.active) item.onlyofficeActivity = activity;
      }

      if (
        thumbsEnabled &&
        stats.isFile() &&
        kind !== 'pdf' &&
        previewable.has(kind.toLowerCase())
      ) {
        item.supportsThumbnail = true;
      }

      // `access`, as a volume held to reading says it: the same lock, the same reason.
      if (!insideReadOnly && ruleSays(logicalChildPath) === 'ro') item.readOnly = 'access';

      if (typeof itemExtras === 'function') {
        Object.assign(item, itemExtras({ name, stats, kind, access: childAccess }) || {});
      }

      return item;
    }
  );

  return { items: items.filter(Boolean), unreadable: unreachable.count };
};

module.exports = {
  listDirectoryItems,
};
