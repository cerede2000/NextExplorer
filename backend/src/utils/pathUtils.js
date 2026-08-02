const path = require('path');
const fs = require('fs');
const { directories, features, personal } = require('../config/index');
const { pathExists } = require('./fsUtils');
const { cachedForRequest, hasRequestContext } = require('./requestContext');
const logger = require('./logger');

const NAME_INVALID_PATTERN = /[\\/]/;
const RESERVED_NAMES = new Set(['.', '..']);
const PERSONAL_ENABLED = Boolean(features && features.personalFolders);

const normalizeRelativePath = (relativePath = '') => {
  if (!relativePath || relativePath === '/') {
    return '';
  }

  const normalized = path.normalize(relativePath.replace(/\\/g, '/')).replace(/^[\\/]+/, '');

  if (normalized === '.') {
    return '';
  }

  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new Error('Invalid path. Traversal outside the volume root is not allowed.');
  }

  return normalized;
};


/**
 * Real (symlink-free) form of the configured roots, resolved once.
 *
 * Containment is a string comparison, which a symbolic link inside the volume
 * defeats. Comparing real paths closes that, but the roots themselves are
 * very often symlinks on a NAS (/mnt -> /volume1), so both sides have to be
 * resolved or every request would be refused.
 */
const realRootCache = new Map();

const realRoot = (root) => {
  if (!realRootCache.has(root)) {
    try {
      realRootCache.set(root, fs.realpathSync(root));
    } catch {
      // The root may not exist yet at startup; fall back to the literal path.
      realRootCache.set(root, root);
    }
  }
  return realRootCache.get(root);
};

// A dangling link may point at another dangling link. Bound the chase the way
// the kernel does rather than trusting the filesystem to be acyclic.
const MAX_SYMLINK_HOPS = 32;

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
};

const readLinkOrNull = (target) => {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
};

/**
 * A bulk operation resolves one path per selected item, and those paths share
 * their parent directories. Only successful lookups are memoized: a path that
 * did not exist a moment ago may have just been created by this very request,
 * and answering "still missing" from a cache would be wrong.
 */
const realpathOrNull = (target) =>
  cachedForRequest('realpath', target, () => {
    try {
      return fs.realpathSync(target);
    } catch {
      return null;
    }
  });

/**
 * Confirm a resolved path really lives under its root once symlinks are
 * followed. Paths that do not exist yet (a file about to be created) are
 * checked through their closest existing ancestor.
 *
 * A broken link is neither: realpath fails on it, but it is not "not created
 * yet" either — checking its parent instead would let `link -> /etc` through
 * on the grounds that the directory holding the link is fine. Such a link is
 * followed by hand and its target checked as a path in its own right.
 */
const assertRealPathWithinRoot = (
  absolutePath,
  root,
  label = 'the configured volume root',
  hops = 0
) => {
  const expectedRoot = realRoot(root);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const realWithSep = expectedRoot.endsWith(path.sep)
    ? expectedRoot
    : `${expectedRoot}${path.sep}`;
  const outside = () => new Error(`Resolved path is outside ${label}.`);
  const contained = (candidate) =>
    candidate === expectedRoot || candidate.startsWith(realWithSep);

  // Resolving the whole path per entry is the expensive part: realpath walks
  // every segment, where a bulk operation shares all but the last. If the
  // parent directory really is inside the root and this entry is not itself a
  // link, then neither can it leave — one lstat instead of a full walk, and
  // the parent's own resolution is memoized for the rest of the request.
  // Only inside a request, where the parent's resolution is memoized and paid
  // once for the whole batch. On its own it would just add a lookup.
  if (hops === 0 && hasRequestContext()) {
    const parent = path.dirname(absolutePath);
    if (parent !== absolutePath && (parent === root || parent.startsWith(rootWithSep))) {
      const realParent = realpathOrNull(parent);
      if (realParent && contained(realParent)) {
        const entry = lstatOrNull(absolutePath);
        if (entry && !entry.isSymbolicLink()) return;
      }
    }
  }

  let candidate = absolutePath;

  for (;;) {
    const realCandidate = realpathOrNull(candidate);

    if (realCandidate) {
      if (!contained(realCandidate)) throw outside();
      return;
    }

    const link = readLinkOrNull(candidate);
    if (link !== null) {
      if (hops >= MAX_SYMLINK_HOPS) {
        throw new Error('Too many levels of symbolic links.');
      }
      const target = path.resolve(path.dirname(candidate), link);
      // The target of a broken link may not exist anywhere, so there is no real
      // path to compare. Judge it on the name: a target outside both spellings
      // of the root is an escape whether or not it exists yet.
      const lexicallyInside =
        target === root ||
        target.startsWith(rootWithSep) ||
        target === expectedRoot ||
        target.startsWith(realWithSep);
      if (!lexicallyInside) throw outside();
      assertRealPathWithinRoot(target, root, label, hops + 1);
      return;
    }

    const parent = path.dirname(candidate);
    // Nothing above the root is ours to judge: the root itself may not exist
    // yet at startup, and the lexical check ran before we got here.
    if (parent === candidate || (parent !== root && !parent.startsWith(rootWithSep))) return;
    candidate = parent;
  }
};

const resolveVolumePath = (relativePath = '') => {
  const safeRelativePath = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(directories.volume, safeRelativePath);

  if (absolutePath !== directories.volume && !absolutePath.startsWith(directories.volumeWithSep)) {
    throw new Error('Resolved path is outside the configured volume root.');
  }

  assertRealPathWithinRoot(absolutePath, directories.volume);

  return absolutePath;
};

const combineRelativePath = (parent = '', name = '') => {
  const normalizedParent = normalizeRelativePath(parent);
  const combined = path.posix.join(normalizedParent, name);
  return normalizeRelativePath(combined);
};

const splitName = (name) => {
  const extension = path.extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  return { base, extension };
};

const findAvailableName = async (directory, desiredName) => {
  let candidate = desiredName;
  let counter = 1;

  while (await pathExists(path.join(directory, candidate))) {
    const { base, extension } = splitName(desiredName);
    candidate = `${base} (${counter})${extension}`;
    counter += 1;
  }

  return candidate;
};

const findAvailableFolderName = async (directory, baseName = 'Untitled Folder') => {
  if (!(await pathExists(path.join(directory, baseName)))) {
    return baseName;
  }

  let counter = 2;
  let candidate = `${baseName} ${counter}`;

  while (await pathExists(path.join(directory, candidate))) {
    counter += 1;
    candidate = `${baseName} ${counter}`;
  }

  return candidate;
};

const ensureValidName = (rawName) => {
  if (typeof rawName !== 'string') {
    throw new Error('A valid name is required.');
  }

  const name = rawName;
  if (!name.trim()) {
    throw new Error('Name cannot be empty.');
  }

  if (NAME_INVALID_PATTERN.test(name)) {
    throw new Error('Name cannot contain path separators.');
  }

  if (name.includes('\0')) {
    throw new Error('Name contains invalid characters.');
  }

  if (RESERVED_NAMES.has(name)) {
    throw new Error('This name is not allowed.');
  }

  return name;
};

const parsePathSpace = (relativePath = '') => {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return { space: 'volume', rel: '' };

  const [first, ...rest] = normalized.split('/');
  if (first === 'personal') {
    // Only treat "personal" as a special space when personal folders are enabled.
    // This allows disambiguation: a volume folder named "personal" can be addressed as
    // "volumes/personal/..." while "personal/..." remains the user's personal space.
    if (!PERSONAL_ENABLED) {
      return { space: 'volume', rel: normalized };
    }
    return { space: 'personal', rel: rest.join('/') };
  }
  if (first === 'volumes') {
    // Backwards-compatible prefix, but also allow a real directory named "volumes".
    // - "volumes/<x>" -> "<x>" (normal prefix behavior)
    // - "volumes" -> "volumes" (directory under volume root)
    return { space: 'volume', rel: rest.length ? rest.join('/') : normalized };
  }
  if (first === 'share') {
    // share/{token}/inner/path
    const [token, ...innerPath] = rest;
    // Allow a real directory named "share" under volume root.
    if (!token) {
      return { space: 'volume', rel: normalized };
    }
    return {
      space: 'share',
      rel: rest.join('/'), // token + inner path
      shareToken: token,
      innerPath: innerPath.join('/'),
    };
  }

  // Backwards-compatible default: treat as volume
  return { space: 'volume', rel: normalized };
};

const getUserFolderName = (user = {}) => {
  const candidates = [];

  const configuredOrder = Array.isArray(personal?.userFolderNameOrder)
    ? personal.userFolderNameOrder
    : [];

  // Always keep a safe fallback order even if the configuration is partial.
  const fallbackOrder = ['id', 'username', 'email_local'];
  const order = Array.from(new Set([...configuredOrder, ...fallbackOrder]));

  for (const token of order) {
    if (token === 'id' && user?.id) {
      candidates.push(String(user.id));
    } else if (token === 'username' && typeof user?.username === 'string' && user.username.trim()) {
      candidates.push(user.username.trim());
    } else if (token === 'email' && typeof user?.email === 'string' && user.email.trim()) {
      candidates.push(user.email.trim());
    } else if (
      token === 'email_local' &&
      typeof user?.email === 'string' &&
      user.email.includes('@')
    ) {
      candidates.push(user.email.split('@')[0]);
    } else if (
      token === 'displayname' &&
      (typeof user?.displayName === 'string' || typeof user?.display_name === 'string')
    ) {
      const displayName = (user.displayName || user.display_name || '').trim();
      if (displayName) candidates.push(displayName);
    }
  }

  candidates.push('user');

  for (const candidate of candidates) {
    try {
      const safe = ensureValidName(String(candidate));
      if (safe) return safe;
    } catch (_) {
      // try next candidate
    }
  }

  return 'user';
};

const getUserRootDir = (user) => {
  if (!PERSONAL_ENABLED) {
    throw new Error('Personal directories are disabled.');
  }
  if (!user || !user.id) {
    throw new Error('User context is required for personal paths.');
  }

  const base = directories.userRoot;
  const folderName = getUserFolderName(user);
  const userRoot = path.resolve(base, folderName);

  // Ensure base and user directory exist (sync to keep resolver synchronous)
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (_) {
    // ignore mkdir errors here; later operations will surface issues
  }

  try {
    fs.mkdirSync(userRoot, { recursive: true });
  } catch (_) {
    // ignore mkdir errors here; later operations will surface issues
  }

  // Safety: ensure userRoot stays under configured userRootWithSep
  if (userRoot !== base && !userRoot.startsWith(directories.userRootWithSep)) {
    throw new Error('Resolved user directory is outside the configured user root.');
  }

  return userRoot;
};

const resolvePersonalPath = (relativePath = '', user) => {
  const safeRelativePath = normalizeRelativePath(relativePath);
  const userRoot = getUserRootDir(user);
  const absolutePath = path.resolve(userRoot, safeRelativePath);

  if (absolutePath !== userRoot && !absolutePath.startsWith(userRoot + path.sep)) {
    throw new Error('Resolved path is outside the configured user directory.');
  }

  assertRealPathWithinRoot(absolutePath, userRoot, 'the configured user directory');

  return absolutePath;
};

const resolveLogicalPath = async (
  relativePath = '',
  { user, guestSession, share, userVolume } = {}
) => {
  const { space, rel, shareToken, innerPath } = parsePathSpace(relativePath);

  logger.debug(
    {
      relativePath,
      space,
      rel,
      shareToken,
      innerPath,
      hasUser: !!user,
      hasGuestSession: !!guestSession,
      hasPreFetchedShare: !!share,
      hasUserVolume: !!userVolume,
    },
    'resolveLogicalPath'
  );

  if (space === 'personal') {
    if (!PERSONAL_ENABLED) {
      throw new Error('Personal directories are disabled.');
    }
    if (!user) {
      throw new Error('User context is required for personal paths.');
    }

    const absolutePath = resolvePersonalPath(rel, user);
    const logical = rel ? `personal/${rel}` : 'personal';

    return {
      space,
      relativePath: logical,
      innerRelativePath: rel,
      absolutePath,
    };
  }

  if (space === 'share') {
    // Resolve share path, passing pre-fetched share if available
    return await resolveSharePath(relativePath, {
      shareToken,
      innerPath,
      share,
    });
  }

  // Handle user volume path resolution
  if (userVolume) {
    // User volume uses label as path prefix, actual path is in userVolume.path
    const pathParts = rel.split('/').filter(Boolean);
    const innerPath = pathParts.slice(1).join('/'); // Everything after the label
    const absolutePath = innerPath ? path.resolve(userVolume.path, innerPath) : userVolume.path;

    // Safety check: ensure resolved path stays within user volume
    const volumePathWithSep = userVolume.path.endsWith(path.sep)
      ? userVolume.path
      : userVolume.path + path.sep;

    if (absolutePath !== userVolume.path && !absolutePath.startsWith(volumePathWithSep)) {
      throw new Error('Resolved path is outside the assigned volume.');
    }

    assertRealPathWithinRoot(absolutePath, userVolume.path, 'the assigned volume');

    return {
      space: 'volume',
      relativePath: rel,
      innerRelativePath: innerPath,
      absolutePath,
      userVolume,
    };
  }

  const absolutePath = resolveVolumePath(rel);

  return {
    space: 'volume',
    relativePath: rel,
    innerRelativePath: rel,
    absolutePath,
  };
};

const resolveSharePath = async (
  relativePath = '',
  { shareToken, innerPath, share: preFetchedShare } = {}
) => {
  // Lazy-load to avoid circular dependency
  const { getShareByToken } = require('../services/sharesService');
  const { getById: getUserById } = require('../services/users');
  const { getVolumeById: getUserVolumeById } = require('../services/userVolumesService');

  logger.debug(
    {
      relativePath,
      shareToken,
      innerPath,
      hasPrefetched: !!preFetchedShare,
    },
    'resolveSharePath called'
  );

  if (!shareToken) {
    const parsed = parsePathSpace(relativePath);
    shareToken = parsed.shareToken;
    innerPath = parsed.innerPath;
  }

  if (!shareToken) {
    logger.debug('resolveSharePath: No shareToken found');
    throw new Error('Share token is required');
  }

  // Use pre-fetched share if available (optimization to avoid duplicate DB query)
  let share = preFetchedShare;
  if (!share) {
    logger.debug({ shareToken }, 'resolveSharePath fetching share from DB');
    share = await getShareByToken(shareToken);
  } else {
    logger.debug({ shareToken }, 'resolveSharePath using pre-fetched share');
  }

  if (!share) {
    logger.debug({ shareToken }, 'resolveSharePath share not found in database');
    throw new Error('Share not found');
  }

  logger.debug(
    {
      shareId: share.id,
      sourceSpace: share.sourceSpace,
      sourcePath: share.sourcePath,
      accessMode: share.accessMode,
    },
    'resolveSharePath share found'
  );

  // Resolve the source path based on space.
  // For directory shares, innerPath is appended inside the directory.
  // For file shares (isDirectory === false), the share always resolves
  // to the original file regardless of innerPath, effectively treating
  // the share as a virtual one-item directory.
  let absolutePath;
  const isDirShare = Boolean(share.isDirectory);

  if (share.sourceSpace === 'personal') {
    const owner = await getUserById(share.ownerId);
    if (!owner) {
      throw new Error('Share owner not found');
    }

    const combinedPath =
      isDirShare && innerPath ? combineRelativePath(share.sourcePath, innerPath) : share.sourcePath;

    absolutePath = resolvePersonalPath(combinedPath, owner);
  } else if (share.sourceSpace === 'user_volume') {
    const [volumeId, ...rest] = String(share.sourcePath || '')
      .split('/')
      .filter(Boolean);
    if (!volumeId) {
      throw new Error('Share source volume is invalid');
    }

    const userVolume = await getUserVolumeById(volumeId);
    if (!userVolume) {
      throw new Error('Share source volume not found');
    }
    if (String(userVolume.userId) !== String(share.ownerId)) {
      throw new Error('Share source volume mismatch');
    }

    const baseWithinVolume = rest.join('/');
    const combinedWithinVolume =
      isDirShare && innerPath ? combineRelativePath(baseWithinVolume, innerPath) : baseWithinVolume;

    absolutePath = combinedWithinVolume
      ? path.resolve(userVolume.path, combinedWithinVolume)
      : userVolume.path;

    const volumePathWithSep = userVolume.path.endsWith(path.sep)
      ? userVolume.path
      : userVolume.path + path.sep;
    if (absolutePath !== userVolume.path && !absolutePath.startsWith(volumePathWithSep)) {
      throw new Error('Resolved path is outside the assigned volume.');
    }

    assertRealPathWithinRoot(absolutePath, userVolume.path, 'the assigned volume');
  } else {
    const combinedPath =
      isDirShare && innerPath ? combineRelativePath(share.sourcePath, innerPath) : share.sourcePath;

    absolutePath = resolveVolumePath(combinedPath);
  }

  return {
    space: 'share',
    relativePath: `share/${shareToken}${innerPath ? '/' + innerPath : ''}`,
    innerRelativePath: innerPath || '',
    absolutePath,
    shareInfo: share,
  };
};

const resolveItemPaths = async (item = {}, options = {}) => {
  if (!item || typeof item.name !== 'string') {
    throw new Error('Each item must include a name.');
  }

  const parentPath = item.path || '';
  const combined = combineRelativePath(parentPath, item.name);
  const { relativePath, absolutePath } = await resolveLogicalPath(combined, options);

  return { relativePath, absolutePath };
};

module.exports = {
  normalizeRelativePath,
  resolveVolumePath,
  resolvePersonalPath,
  resolveLogicalPath,
  resolveSharePath,
  combineRelativePath,
  splitName,
  findAvailableName,
  findAvailableFolderName,
  ensureValidName,
  parsePathSpace,
  getUserFolderName,
  getUserRootDir,
  resolveItemPaths,
};
