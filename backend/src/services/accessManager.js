const { parsePathSpace, resolveLogicalPath, combineRelativePath } = require('../utils/pathUtils');
const { getPermissionForPath } = require('./accessControlService');
const { getShareByToken, hasUserPermission, isShareExpired } = require('./sharesService');
const { getUserVolumeForPath, getVolumeById } = require('./userVolumesService');
const { auth, features } = require('../config/index');

/**
 * Whether a share password still means anything for this caller.
 *
 * The owner is exempt: it is their own share. With authentication disabled
 * everyone is the same synthetic admin who already browses the whole
 * filesystem, so the prompt would only lock the share without protecting it.
 *
 * Everyone else is subject to it, and that includes a visitor with no account
 * at all — the very people a public password is for. This used to require a
 * user, so the predicate answered "no password here" for anonymous callers and
 * each caller made up the difference on its own: one added `|| (hasPassword &&
 * !user)` to what it reported, another let the case fall through to a later
 * branch that happened to refuse. The protection was real and lived in two
 * places under a name that promised one.
 */
const sharePasswordApplies = (share, user) =>
  Boolean(share.hasPassword) &&
  auth.enabled !== false &&
  !(user && String(user.id) === String(share.ownerId));

/**
 * Get comprehensive access information for a path
 * @param {Object} context - { user, guestSession, shareToken }
 * @param {string} relativePath - Logical path (e.g., 'personal/docs', 'share/abc123/file.txt')
 * @param {Object} [options]
 * @param {Function} [options.permissionResolver] - (relativePath) => 'rw'|'ro'|'hidden'
 * @param {Map<string, Object>} [options.shareCache] - shareToken -> share
 * @param {Map<string, Object>} [options.userVolumeCache] - volumeId -> userVolume
 * @returns {Object} Access metadata
 */
const getAccessInfo = async (context, relativePath, options = {}) => {
  const { space, rel, shareToken, innerPath } = parsePathSpace(relativePath);

  // Determine access based on space
  switch (space) {
    case 'volume':
      return await getVolumeAccess(context, rel, options);
    case 'personal':
      return await getPersonalAccess(context, rel);
    case 'share':
      return await getShareAccess(context, shareToken, innerPath, options);
    default:
      return createDeniedAccess('Unknown path space');
  }
};

/**
 * Get access info for volume paths
 */
const getVolumeAccess = async (context, relativePath, options = {}) => {
  const { user, guestSession } = context;
  const permissionResolver =
    typeof options.permissionResolver === 'function' ? options.permissionResolver : null;
  const getPerm = async (p) =>
    permissionResolver ? permissionResolver(p) : await getPermissionForPath(p);

  // Guests cannot access volumes directly (only through shares).
  // If an authenticated user is present, prefer the user context over any stale guest session.
  if (guestSession && !user) {
    return createDeniedAccess('Guests cannot access volumes');
  }

  // Users must be authenticated
  if (!user || !user.id) {
    return createDeniedAccess('Authentication required');
  }

  const isAdmin = user.roles && user.roles.includes('admin');

  // Check user volume restrictions when USER_VOLUMES is enabled
  if (features.userVolumes && !isAdmin) {
    const userVolume = await getUserVolumeForPath(user.id, relativePath);
    if (!userVolume) {
      return createDeniedAccess('You do not have access to this volume');
    }

    // Use the volume's access mode
    const isReadOnly = userVolume.accessMode === 'readonly';

    // Also check path-level access control rules
    const permission = await getPerm(relativePath);
    if (permission === 'hidden') {
      return createDeniedAccess('Path is hidden');
    }

    const effectiveReadOnly = isReadOnly || permission === 'ro';

    return {
      canAccess: true,
      canRead: true,
      canWrite: !effectiveReadOnly,
      canDelete: !effectiveReadOnly,
      canUpload: !effectiveReadOnly,
      canCreateFolder: !effectiveReadOnly,
      canCreateFile: !effectiveReadOnly,
      canShare: true,
      canDownload: true,
      isShared: false,
      shareInfo: null,
      userVolume, // Include user volume info for path resolution
      effectivePermission: effectiveReadOnly ? 'ro' : 'rw',
      denialReason: null,
    };
  }

  // Standard access for admins or when USER_VOLUMES is disabled
  // Check access control rules
  const permission = await getPerm(relativePath);
  if (permission === 'hidden') {
    return createDeniedAccess('Path is hidden');
  }

  const isReadOnly = permission === 'ro';

  return {
    canAccess: true,
    canRead: true,
    canWrite: !isReadOnly || isAdmin,
    canDelete: !isReadOnly || isAdmin,
    canUpload: !isReadOnly || isAdmin,
    canCreateFolder: !isReadOnly || isAdmin,
    canCreateFile: !isReadOnly || isAdmin,
    canShare: true,
    canDownload: true,
    isShared: false,
    shareInfo: null,
    effectivePermission: permission,
    denialReason: null,
  };
};

/**
 * Get access info for personal paths
 */
// eslint-disable-next-line no-unused-vars
const getPersonalAccess = async (context, relativePath) => {
  const { user, guestSession } = context;

  // Guests cannot access personal folders
  if (guestSession && !user) {
    return createDeniedAccess('Guests cannot access personal folders');
  }

  // Users must be authenticated
  if (!user || !user.id) {
    return createDeniedAccess('Authentication required');
  }

  // Users have full access to their own personal space
  return {
    canAccess: true,
    canRead: true,
    canWrite: true,
    canDelete: true,
    canUpload: true,
    canCreateFolder: true,
    canCreateFile: true,
    canShare: true,
    canDownload: true,
    isShared: false,
    shareInfo: null,
    effectivePermission: 'rw',
    denialReason: null,
  };
};

/**
 * Whether the share itself may be opened, before anyone is considered.
 *
 * @returns {object|null} a denial, or null when the share is usable
 */
const shareIsUnusable = (share) => {
  if (!share) return createDeniedAccess('Share not found');
  if (isShareExpired(share)) return createDeniedAccess('Share has expired');
  return null;
};

/**
 * Whether this caller may open it.
 *
 * The two sharing types ask different questions — one wants an account on the
 * list, the other wants a session that came through the door — and anything
 * else fails closed rather than falling through to the grant below.
 *
 * @returns {Promise<object|null>} a denial, or null when the caller may open it
 */
const callerMayNotOpen = async (share, { user, guestSession }) => {
  if (share.sharingType === 'users') {
    if (!user || !user.id) return createDeniedAccess('Authentication required');
    const permitted = await hasUserPermission(share.id, user.id);
    return permitted ? null : createDeniedAccess('Access denied');
  }

  if (share.sharingType === 'anyone') {
    // Password verification happens during share access; a caller with neither
    // an account nor a guest session has been through neither.
    if (!user && !guestSession) return createDeniedAccess('Share access required');

    if (guestSession && !user && guestSession.shareId !== share.id) {
      return createDeniedAccess('Invalid guest session for this share');
    }

    // Being signed in is not the same as knowing the password. Without this,
    // any authenticated user opening a protected link skipped the prompt the
    // owner set it up for.
    if (sharePasswordApplies(share, user)) {
      const verified = guestSession && guestSession.shareId === share.id;
      if (!verified) return createDeniedAccess('Password verification required');
    }
    return null;
  }

  // Fail closed: a sharing type we do not know about must not fall through to
  // the permission grant.
  return createDeniedAccess('Unknown sharing type');
};

/**
 * What the location underneath still allows, which caps what the share grants.
 *
 * An administrator hiding a folder, marking it read-only or reassigning a
 * personal volume takes effect on every existing link immediately, because the
 * answer is read here on every request rather than frozen when the link was
 * made.
 *
 * @returns {Promise<{denial: object}|{readOnly: boolean}>}
 */
const readSourceLimits = async (share, innerPath, { getPerm, userVolumeCache }) => {
  const isDirShare = Boolean(share.isDirectory);
  const safeInnerPath = typeof innerPath === 'string' ? innerPath : '';
  const under = (base) =>
    isDirShare && safeInnerPath ? combineRelativePath(base, safeInnerPath) : base;

  if (share.sourceSpace === 'volume') {
    const permission = await getPerm(under(share.sourcePath));
    if (permission === 'hidden') return { denial: createDeniedAccess('Path is hidden') };
    return { readOnly: permission === 'ro' };
  }

  if (share.sourceSpace === 'user_volume') {
    const [volumeId, ...rest] = String(share.sourcePath || '')
      .split('/')
      .filter(Boolean);
    if (!volumeId) return { denial: createDeniedAccess('Share source volume is invalid') };

    let userVolume = userVolumeCache ? userVolumeCache.get(volumeId) : null;
    if (!userVolume) {
      userVolume = await getVolumeById(volumeId);
      if (userVolumeCache && userVolume) userVolumeCache.set(volumeId, userVolume);
    }
    if (!userVolume) return { denial: createDeniedAccess('Share source volume not found') };

    // A share may only hand out a volume its own owner holds: without this, an
    // account that once had one assigned could go on sharing it afterwards.
    if (String(userVolume.userId) !== String(share.ownerId)) {
      return { denial: createDeniedAccess('Share source volume mismatch') };
    }

    const logicalForRules = `${userVolume.label}${under(rest.join('/')) ? `/${under(rest.join('/'))}` : ''}`;
    const permission = await getPerm(logicalForRules);
    if (permission === 'hidden') return { denial: createDeniedAccess('Path is hidden') };
    return { readOnly: userVolume.accessMode === 'readonly' || permission === 'ro' };
  }

  return { readOnly: false };
};

/** What the share hands out, once the location underneath has had its say. */
const grantFor = (share, { user, readOnly }) => {
  const isReadWrite = share.accessMode === 'readwrite' && !readOnly;

  return {
    canAccess: true,
    canRead: true,
    canWrite: isReadWrite,
    canDelete: isReadWrite && share.allowDelete !== false,
    canUpload: isReadWrite && share.allowUpload !== false,
    canCreateFolder: isReadWrite && share.allowCreateFolder !== false,
    canCreateFile: isReadWrite && share.allowCreateFile !== false,
    canShare: false, // Cannot create shares within shares
    // Deliberately not gated on `isReadWrite` like the others above it: a
    // read-only share is exactly where withholding downloads means something —
    // "read this" rather than "take a copy of this". Defaults to allowed, so
    // every share made before this existed behaves as it always did.
    canDownload: share.allowDownload !== false,
    isShared: true,
    shareInfo: {
      shareId: share.id,
      shareToken: share.shareToken,
      accessMode: isReadWrite ? 'readwrite' : 'readonly',
      expiresAt: share.expiresAt,
      isOwner: Boolean(user && user.id === share.ownerId),
      label: share.label,
    },
    share, // Include full share object for path resolution (avoids duplicate DB query)
    effectivePermission: isReadWrite ? 'rw' : 'ro',
    denialReason: null,
  };
};

/**
 * What a caller may do with a path inside a share.
 *
 * Three questions in order, each answerable on its own: may this share be
 * opened at all, may this caller open it, and what does the location underneath
 * still allow. Only then is a grant composed. It was one function of fifty-three
 * paths, which is fifty-three tests to know it — and the reason it is worth
 * splitting is that it decides what a link hands out.
 */
/**
 * The optional machinery a caller may hand in: a permission resolver, and two
 * caches for a route that is asking about many paths at once. Normalised here
 * so the decision below reads as the sequence of questions it is.
 */
const readOptions = (options = {}) => {
  const permissionResolver =
    typeof options.permissionResolver === 'function' ? options.permissionResolver : null;

  return {
    getPerm: async (p) => (permissionResolver ? permissionResolver(p) : getPermissionForPath(p)),
    shareCache: options.shareCache instanceof Map ? options.shareCache : null,
    userVolumeCache: options.userVolumeCache instanceof Map ? options.userVolumeCache : null,
  };
};

/** The share this token names, from the caller's cache when it has one. */
const loadShare = async (shareToken, shareCache) => {
  const cached = shareCache ? shareCache.get(shareToken) : null;
  if (cached) return cached;

  const share = await getShareByToken(shareToken);
  if (shareCache && share) shareCache.set(shareToken, share);
  return share;
};

const getShareAccess = async (context, shareToken, innerPath, options = {}) => {
  if (!shareToken) return createDeniedAccess('Share token is required');

  const { getPerm, shareCache, userVolumeCache } = readOptions(options);
  const share = await loadShare(shareToken, shareCache);

  const unusable = shareIsUnusable(share);
  if (unusable) return unusable;

  const refused = await callerMayNotOpen(share, context);
  if (refused) return refused;

  const limits = await readSourceLimits(share, innerPath, { getPerm, userVolumeCache });
  if (limits.denial) return limits.denial;

  return grantFor(share, { user: context.user, readOnly: limits.readOnly });
};

/**
 * Helper to create a denied access object
 */
const createDeniedAccess = (reason) => {
  return {
    canAccess: false,
    canRead: false,
    canWrite: false,
    canDelete: false,
    canUpload: false,
    canCreateFolder: false,
    canCreateFile: false,
    canShare: false,
    canDownload: false,
    isShared: false,
    shareInfo: null,
    effectivePermission: 'hidden',
    denialReason: reason,
  };
};

/**
 * Quick check if a user/guest can access a path
 */
const canAccess = async (context, relativePath) => {
  const info = await getAccessInfo(context, relativePath);
  return info.canAccess;
};

/**
 * Check if a path can be written to
 */
const canWrite = async (context, relativePath) => {
  const info = await getAccessInfo(context, relativePath);
  return info.canWrite;
};

/**
 * Resolve a logical path to filesystem path with unified access checks.
 * - First evaluates access via getAccessInfo.
 * - If canAccess is false, returns { accessInfo, resolved: null }.
 * - If canAccess is true, resolves the logical path to an absolute path
 *   using resolveLogicalPath with the same user/guestSession context.
 *
 * @param {Object} context - { user, guestSession }
 * @param {string} relativePath - Logical path (e.g., 'personal/docs', 'share/abc123/file.txt')
 * @returns {Promise<{ accessInfo: Object, resolved: Object|null }>}
 */
const resolvePathWithAccess = async (context, relativePath, options = {}) => {
  const accessInfo = await getAccessInfo(context, relativePath, options);

  if (!accessInfo.canAccess) {
    return { accessInfo, resolved: null };
  }

  // Pass pre-fetched share and user volume to avoid duplicate DB queries
  const resolved = await resolveLogicalPath(relativePath, {
    user: context.user || null,
    guestSession: context.guestSession || null,
    share: accessInfo.share || null,
    userVolume: accessInfo.userVolume || null,
  });

  return { accessInfo, resolved };
};

module.exports = {
  getAccessInfo,
  getPersonalAccess,
  getShareAccess,
  canAccess,
  canWrite,
  sharePasswordApplies,
  resolvePathWithAccess,
};
