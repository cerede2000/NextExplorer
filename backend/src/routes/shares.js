const express = require('express');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  RateLimitError,
} = require('../errors/AppError');
const { ErrorCodes } = require('../errors/errorCodes');
const {
  createShare,
  getShareById,
  getShareByToken,
  getSharesByOwnerId,
  getSharesForUser,
  updateShare,
  deleteShare,
  verifySharePassword,
  hasUserPermission,
  isShareExpired,
  trackShareAccess,
  trackShareDownload,
  getShareStats,
} = require('../services/sharesService');
const { createGuestSession } = require('../services/guestSessionService');
const { normalizeRelativePath, parsePathSpace } = require('../utils/pathUtils');
const { pathExists } = require('../utils/fsUtils');
const { resolvePathWithAccess, sharePasswordApplies } = require('../services/accessManager');
const { extensions, mimeTypes } = require('../config/index');
const { getSettings, getUserSettings } = require('../services/settingsService');
const { listDirectoryItems } = require('../services/directoryListingService');
const { encodeContentDisposition } = require('./files/utils');
const { collectArchiveEntries, appendEntries } = require('../services/archiveTree');
const logger = require('../utils/logger');

const activityLog = require('../services/activityLog');
const versions = require('../services/versions/operations');
const { sendTextFile } = require('../utils/textFileResponse');
const { clientAddress } = require('../utils/clientAddress');
const {
  readTextFileHead,
  encodeText,
  MAX_EDITOR_FILE_SIZE,
} = require('../services/textEditorService');

const router = express.Router();

// Verifying a share password runs bcrypt, so an unlimited endpoint is both a
// brute-force surface and a way to keep the event loop busy. Share links are
// public, so this is the only barrier in front of that hash.
const sharePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
    next(
      new RateLimitError(
        'Too many attempts. Please wait before trying this link again.',
        retryAfterSeconds,
        ErrorCodes.RATE_LIMIT_EXCEEDED
      )
    );
  },
});

/**
 * Guest session cookies follow the same rules as the login session cookie:
 * secure whenever the request reached us over HTTPS (directly or through a
 * trusted proxy), so the cookie is not replayed in clear text.
 */
const guestSessionCookieOptions = (req) => ({
  httpOnly: true,
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  sameSite: 'lax',
  secure: req.secure === true,
  path: '/api', // Ensure cookie is sent for all /api/* requests
});

const buildPublicBaseUrl = (req) => {
  const { public: publicConfig } = require('../config/index');
  return publicConfig.origin || `${req.protocol}://${req.get('host')}`;
};

const encodeUrlPath = (value = '') =>
  String(value).split('/').filter(Boolean).map(encodeURIComponent).join('/');

const DIRECT_FILE_MODES = new Set(['auto', 'download', 'inline', 'raw', 'view']);
const TEXT_LIKE_EXTENSIONS = new Set([
  'bat',
  'bash',
  'c',
  'cfg',
  'cmd',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'fish',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'less',
  'log',
  'mjs',
  'md',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);
const TEXT_LIKE_FILENAMES = new Set(['dockerfile', 'makefile', 'readme', 'license']);
const FORCE_PLAIN_TEXT_EXTENSIONS = new Set([
  'bat',
  'bash',
  'cmd',
  'fish',
  'htm',
  'html',
  'js',
  'jsx',
  'mjs',
  'ps1',
  'sh',
  'svg',
  'ts',
  'tsx',
  'zsh',
]);
const INLINE_MIME_PREFIXES = ['audio/', 'image/', 'text/', 'video/'];
const INLINE_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
]);

const normalizeDirectFileMode = (mode) => {
  const value = typeof mode === 'string' ? mode.toLowerCase() : 'auto';
  if (!DIRECT_FILE_MODES.has(value)) return 'auto';
  return value === 'view' ? 'inline' : value;
};

const isTextLikeFile = (filename, extension) => {
  const lowerName = filename.toLowerCase();
  return TEXT_LIKE_EXTENSIONS.has(extension) || TEXT_LIKE_FILENAMES.has(lowerName);
};

const getDirectFilePresentation = (filename, requestedMode) => {
  const mode = normalizeDirectFileMode(requestedMode);
  const extension = path.extname(filename).slice(1).toLowerCase();
  const detectedMimeType = mimeTypes[extension] || 'application/octet-stream';
  const textLike = isTextLikeFile(filename, extension);
  const inlineMime =
    INLINE_MIME_PREFIXES.some((prefix) => detectedMimeType.startsWith(prefix)) ||
    INLINE_MIME_TYPES.has(detectedMimeType);
  const canInline = textLike || inlineMime;
  const forceDownload = mode === 'download' || !canInline;
  const disposition = forceDownload ? 'attachment' : 'inline';

  let contentType = detectedMimeType;
  if (!forceDownload && textLike) {
    const shouldUsePlainText =
      mode === 'inline' ||
      detectedMimeType === 'application/octet-stream' ||
      FORCE_PLAIN_TEXT_EXTENSIONS.has(extension);
    contentType = shouldUsePlainText ? 'text/plain; charset=utf-8' : detectedMimeType;
  }

  return {
    contentType,
    disposition,
  };
};

const buildDirectFilePath = (shareToken, innerPath = '', mode = 'auto') => {
  const encodedToken = encodeURIComponent(shareToken);
  const encodedInnerPath = encodeUrlPath(innerPath);
  const normalizedMode = normalizeDirectFileMode(mode);
  const query = normalizedMode === 'auto' ? '' : `?mode=${encodeURIComponent(normalizedMode)}`;
  const pathPart = encodedInnerPath
    ? `/api/share/${encodedToken}/file/${encodedInnerPath}`
    : `/api/share/${encodedToken}/file`;
  return `${pathPart}${query}`;
};

const getSafeRedirectTarget = (target) => {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    return null;
  }
  return target;
};

const redirectToShareAccess = (req, res, shareToken) => {
  const redirectTarget = getSafeRedirectTarget(req.originalUrl || '');
  const redirectQuery = redirectTarget ? `?redirect=${encodeURIComponent(redirectTarget)}` : '';
  res.redirect(302, `/share/${encodeURIComponent(shareToken)}${redirectQuery}`);
};

const streamResolvedFile = async ({ absolutePath, stats, mode, req, res }) => {
  const filename = path.basename(absolutePath);
  const { contentType, disposition } = getDirectFilePresentation(filename, mode);

  const streamFile = (options = undefined) => {
    const stream = options
      ? fss.createReadStream(absolutePath, options)
      : fss.createReadStream(absolutePath);
    stream.on('error', (streamError) => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(streamError);
      }
    });
    stream.pipe(res);
  };

  const baseHeaders = {
    'Content-Type': contentType,
    'Content-Disposition': encodeContentDisposition(filename, disposition),
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const bytesPrefix = 'bytes=';
    if (!rangeHeader.startsWith(bytesPrefix)) {
      res.status(416).send('Malformed Range header');
      return;
    }

    const [startString, endString] = rangeHeader.slice(bytesPrefix.length).split('-');
    let start = Number(startString);
    let end = endString ? Number(endString) : stats.size - 1;

    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= stats.size) end = stats.size - 1;

    if (start > end) {
      res.status(416).send('Range Not Satisfiable');
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
    });
    streamFile({ start, end });
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': stats.size,
    'Accept-Ranges': 'bytes',
  });
  streamFile();
};

const streamResolvedDirectoryZip = async ({
  absolutePath,
  logicalPath,
  context,
  archiveName,
  res,
}) => {
  const safeArchiveName = archiveName && archiveName.trim() ? archiveName.trim() : 'download';
  const filename = safeArchiveName.toLowerCase().endsWith('.zip')
    ? safeArchiveName
    : `${safeArchiveName}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', encodeContentDisposition(filename, 'attachment'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (archiveError) => {
    logger.error({ err: archiveError }, 'Direct share archive creation failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive.' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  // What the share lets its visitor see, not everything below its folder: a
  // personal root and the paths an access rule hides stay out.
  const stats = await fs.stat(absolutePath);
  const { entries } = await collectArchiveEntries(context, [
    {
      absolutePath,
      logicalPath,
      entryName: path.basename(absolutePath) || safeArchiveName,
      stats,
    },
  ]);
  appendEntries(archive, entries);
  await archive.finalize();
};

/**
 * POST /api/shares - Create a new share
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const {
      sourcePath,
      accessMode = 'readonly',
      sharingType = 'anyone',
      password,
      userIds,
      expiresAt,
      label,
    } = req.body;

    if (!sourcePath) {
      throw new ValidationError('Source path is required');
    }

    // Parse and validate source path
    const { space, rel } = parsePathSpace(sourcePath);

    if (space === 'share') {
      throw new ValidationError('Cannot create shares from shared paths');
    }

    // Resolve the path to check if it exists
    let resolved;
    try {
      const { accessInfo, resolved: resolvedWithAccess } = await resolvePathWithAccess(
        { user: req.user, guestSession: req.guestSession },
        sourcePath
      );
      if (!accessInfo?.canAccess || !resolvedWithAccess) {
        throw new ForbiddenError(accessInfo?.denialReason || 'Access denied');
      }
      if (accessMode === 'readwrite' && !accessInfo.canWrite) {
        throw new ValidationError('Cannot create a read-write share for a read-only path');
      }
      resolved = resolvedWithAccess;
    } catch (error) {
      if (error?.statusCode) throw error;
      throw new ValidationError('Invalid source path');
    }

    // Check if path exists
    if (!(await pathExists(resolved.absolutePath))) {
      throw new NotFoundError('Source path does not exist');
    }

    // Check if it's a directory
    const stats = await fs.stat(resolved.absolutePath);
    const isDirectory = stats.isDirectory();

    // Validate expiration date if provided
    let validExpiresAt = null;
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      if (isNaN(expiryDate.getTime())) {
        throw new ValidationError('Invalid expiration date');
      }
      if (expiryDate <= new Date()) {
        throw new ValidationError('Expiration date must be in the future');
      }
      validExpiresAt = expiryDate.toISOString();
    }

    // Create the share
    const sourceSpaceForDb = resolved?.userVolume ? 'user_volume' : space;
    const sourcePathForDb = resolved?.userVolume
      ? `${resolved.userVolume.id}${resolved.innerRelativePath ? `/${resolved.innerRelativePath}` : ''}`
      : rel || resolved.innerRelativePath;

    const share = await createShare({
      ownerId: req.user.id,
      sourceSpace: sourceSpaceForDb,
      sourcePath: sourcePathForDb,
      isDirectory,
      accessMode,
      sharingType,
      password,
      userIds: sharingType === 'users' ? userIds : [],
      expiresAt: validExpiresAt,
      label,
    });

    await activityLog.record({
      action: 'share.create',
      user: req.user,
      target: share.sourcePath,
      detail: { label: share.label || null, expiresAt: share.expiresAt || null },
      req,
    });

    // Generate share URL using PUBLIC_URL if configured, otherwise use request host
    const baseUrl = buildPublicBaseUrl(req);
    const shareUrl = `${baseUrl}/share/${share.shareToken}`;
    const directFileUrl = `${baseUrl}${buildDirectFilePath(share.shareToken)}`;

    res.status(201).json({
      ...share,
      shareUrl,
      directFileUrl,
    });
  })
);

/**
 * GET /api/shares - List user's shares
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const shares = await getSharesByOwnerId(req.user.id);

    res.json({ shares });
  })
);

/**
 * GET /api/shares/shared-with-me - List shares shared with the current user
 */
router.get(
  '/shared-with-me',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const shares = await getSharesForUser(req.user.id);

    res.json({ shares });
  })
);

/**
 * GET /api/shares/:id - Get share details (owner only)
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const share = await getShareById(req.params.id);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    // Only owner can view details
    if (share.ownerId !== req.user.id) {
      throw new ForbiddenError('Access denied');
    }

    // Get statistics
    const stats = await getShareStats(share.id);

    res.json({
      ...share,
      stats,
    });
  })
);

/**
 * PUT /api/shares/:id - Update share
 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const share = await getShareById(req.params.id);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    // Only owner can update
    if (share.ownerId !== req.user.id) {
      throw new ForbiddenError('Access denied');
    }

    const updates = {};

    if ('accessMode' in req.body) {
      updates.accessMode = req.body.accessMode;
    }

    if ('sharingType' in req.body) {
      updates.sharingType = req.body.sharingType;
    }

    if ('password' in req.body) {
      updates.password = req.body.password;
    }

    if ('expiresAt' in req.body) {
      if (req.body.expiresAt) {
        const expiryDate = new Date(req.body.expiresAt);
        if (isNaN(expiryDate.getTime())) {
          throw new ValidationError('Invalid expiration date');
        }
        updates.expiresAt = expiryDate.toISOString();
      } else {
        updates.expiresAt = null;
      }
    }

    if ('label' in req.body) {
      updates.label = req.body.label;
    }

    if ('userIds' in req.body) {
      updates.userIds = req.body.userIds;
    }

    const updated = await updateShare(share.id, updates);

    res.json(updated);
  })
);

/**
 * DELETE /api/shares/:id - Delete share
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const share = await getShareById(req.params.id);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    // Only owner can delete
    if (share.ownerId !== req.user.id) {
      throw new ForbiddenError('Access denied');
    }

    await deleteShare(share.id);
    await activityLog.record({
      action: 'share.delete',
      user: req.user,
      target: share.sourcePath,
      detail: { label: share.label || null },
      req,
    });

    res.status(204).end();
  })
);

/**
 * GET /api/share/:token/info - Get public share info (before authentication)
 */
router.get(
  '/:token/info',
  asyncHandler(async (req, res) => {
    const share = await getShareByToken(req.params.token);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    // Return limited public info
    res.json({
      shareToken: share.shareToken,
      label: share.label,
      isDirectory: share.isDirectory,
      hasPassword: share.hasPassword,
      // Whether this caller has to type it: its owner does not, and neither
      // does anybody when authentication is off. The interface asks for the
      // password on this, rather than on hasPassword, so the owner is not sent
      // to a prompt the server would have let them skip.
      requiresPassword: sharePasswordApplies(share, req.user),
      sharingType: share.sharingType,
      expiresAt: share.expiresAt,
      isExpired: isShareExpired(share),
    });
  })
);

/**
 * POST /api/share/:token/verify - Verify password for password-protected share
 */
router.post(
  '/:token/verify',
  sharePasswordLimiter,
  asyncHandler(async (req, res) => {
    const { password } = req.body;

    const share = await getShareByToken(req.params.token);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    if (isShareExpired(share)) {
      throw new ForbiddenError('Share has expired');
    }

    // Check if password is required
    if (!share.hasPassword) {
      // No password required, just create guest session
      if (share.sharingType === 'anyone') {
        const session = await createGuestSession({
          shareId: share.id,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });

        // Set guest session cookie
        res.cookie('guestSession', session.id, guestSessionCookieOptions(req));

        res.json({
          success: true,
          guestSessionId: session.id,
        });
        return;
      } else {
        // User-specific share without password still requires auth
        throw new UnauthorizedError('Authentication required');
      }
    }

    // Verify password
    const valid = await verifySharePassword(share.id, password);

    if (!valid) {
      throw new UnauthorizedError('Invalid password');
    }

    // Create guest session for anyone shares
    if (share.sharingType === 'anyone') {
      const session = await createGuestSession({
        shareId: share.id,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      // Set guest session cookie
      res.cookie('guestSession', session.id, guestSessionCookieOptions(req));

      res.json({
        success: true,
        guestSessionId: session.id,
      });
    } else {
      // User-specific shares still need user authentication
      res.json({
        success: true,
        requiresAuth: true,
      });
    }
  })
);

/**
 * GET /api/share/:token/access - Access share (creates session if needed)
 */
router.get(
  '/:token/access',
  asyncHandler(async (req, res) => {
    const share = await getShareByToken(req.params.token);

    if (!share) {
      throw new NotFoundError('Share not found');
    }

    if (isShareExpired(share)) {
      throw new ForbiddenError('Share has expired');
    }

    // Track access
    await trackShareAccess(share.id, { ipAddress: req.ip });

    // Check if user has permission
    if (share.sharingType === 'users') {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required');
      }

      const { hasUserPermission } = require('../services/sharesService');
      const permitted = await hasUserPermission(share.id, req.user.id);

      if (!permitted) {
        throw new ForbiddenError('Access denied');
      }
    } else {
      // A password protects the link from everyone but its owner. Being signed
      // in is not knowing it, so an authenticated visitor is sent through the
      // same prompt unless they already verified it (guest session) or own it.
      if (sharePasswordApplies(share, req.user)) {
        const verified = req.guestSession && req.guestSession.shareId === share.id;
        if (!verified) {
          throw new UnauthorizedError('Password verification required');
        }
      }

      // Anyone share - always create a new guest session for this share
      // This ensures switching between shares in the same browser works correctly
      if (!req.user) {
        // Unless there already is one for this share. Reloading the page calls
        // here again, and a visitor who has just typed the password holds a
        // session that says so — the check above has already accepted it. Not
        // looking made the branch below ask for the password a second time,
        // for a share it had just been given.
        if (req.guestSession && req.guestSession.shareId === share.id) {
          return res.json({
            share: {
              shareToken: share.shareToken,
              label: share.label,
              sourcePath: `share/${share.shareToken}`,
              accessMode: share.accessMode,
              isDirectory: share.isDirectory,
            },
            guestSessionId: req.guestSession.id,
          });
        }

        // Create guest session if no password required
        if (!share.hasPassword) {
          const session = await createGuestSession({
            shareId: share.id,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
          });

          // Set guest session cookie (overwrites any existing session)
          res.cookie('guestSession', session.id, guestSessionCookieOptions(req));

          return res.json({
            share: {
              shareToken: share.shareToken,
              label: share.label,
              sourcePath: `share/${share.shareToken}`,
              accessMode: share.accessMode,
              isDirectory: share.isDirectory,
            },
            guestSessionId: session.id,
          });
        } else {
          throw new UnauthorizedError('Password verification required');
        }
      }
    }

    // Return share access info
    res.json({
      share: {
        shareToken: share.shareToken,
        label: share.label,
        sourcePath: `share/${share.shareToken}`,
        accessMode: share.accessMode,
        isDirectory: share.isDirectory,
        expiresAt: share.expiresAt,
      },
      guestSessionId: req.guestSession?.id || null,
    });
  })
);

/**
 * A file that left through a link.
 *
 * The share's own counters answer "how many"; this answers "which file, when,
 * and from where" — the question somebody actually asks the day a link turns
 * out to have been handed around. The person on the other end has no account,
 * so the actor is the link itself.
 */
const recordShareDownload = ({ share, resolved, req }) =>
  activityLog.record({
    action: 'share.download',
    user: req.user,
    actor: req.user?.username || share.label || `link ${share.shareToken?.slice(0, 8)}`,
    target: resolved.relativePath || share.sourcePath,
    detail: { share: share.label || null, token: share.shareToken?.slice(0, 8) || null },
    req,
  });

/**
 * The file a share link points at, and what this caller may do with it.
 *
 * Everything a request through a link has to get past before the file is
 * touched: the link itself, who is following it, and what the location
 * underneath still allows. Written once because three routes ask it — the
 * direct file, and the two the editor uses — and each asks for something
 * slightly different, which is what the options are.
 *
 * @returns the target, or null when the caller was redirected to the share's
 *   own door and there is nothing more for the route to do.
 */
const resolveSharedFileTarget = async (
  req,
  res,
  { requireDownload = false, requireWrite = false, allowSharedFileName = false } = {}
) => {
  const shareToken = req.params.token;
  const rawInnerPath = (req.params.splat || []).join('/');
  let innerPath;

  try {
    innerPath = rawInnerPath ? normalizeRelativePath(rawInnerPath) : '';
  } catch (_) {
    throw new ValidationError('Invalid file path.');
  }

  const share = await getShareByToken(shareToken);
  if (!share) {
    throw new NotFoundError('Share not found');
  }

  if (isShareExpired(share)) {
    throw new ForbiddenError('Share has expired');
  }

  if (!share.isDirectory && innerPath) {
    // File shares already identify their target. Permit only its exact name so
    // friendly editor URLs work without opening arbitrary descendant paths.
    const targetName = path.basename(share.sourcePath || '');
    if (!allowSharedFileName || innerPath !== targetName) {
      throw new NotFoundError('Path not found');
    }
    innerPath = '';
  }

  if (share.sharingType === 'users') {
    if (!req.user || !req.user.id) {
      redirectToShareAccess(req, res, shareToken);
      return null;
    }

    const permitted = await hasUserPermission(share.id, req.user.id);
    if (!permitted) {
      throw new ForbiddenError('Access denied');
    }
  }

  let guestSession = req.guestSession || null;

  if (share.sharingType === 'anyone' && !req.user) {
    if (share.hasPassword) {
      if (!guestSession || guestSession.shareId !== share.id) {
        redirectToShareAccess(req, res, shareToken);
        return null;
      }
    } else {
      // Public direct file links should work without first visiting the Web UI.
      guestSession = guestSession?.shareId === share.id ? guestSession : { shareId: share.id };
    }
  }

  const logicalPath = innerPath ? `share/${shareToken}/${innerPath}` : `share/${shareToken}`;
  const context = { user: req.user, guestSession };
  const { accessInfo, resolved } = await resolvePathWithAccess(context, logicalPath);

  if (
    !accessInfo ||
    !accessInfo.canAccess ||
    !accessInfo.canRead ||
    (requireDownload && !accessInfo.canDownload) ||
    (requireWrite && !accessInfo.canWrite) ||
    !resolved
  ) {
    throw new ForbiddenError(accessInfo?.denialReason || 'File access not allowed.');
  }

  if (!(await pathExists(resolved.absolutePath))) {
    throw new NotFoundError('Path not found');
  }

  const stats = await fs.stat(resolved.absolutePath);
  return { share, innerPath, accessInfo, resolved, stats, context };
};

const handleDirectFileRequest = async (req, res) => {
  const mode = normalizeDirectFileMode(req.query?.mode);
  const target = await resolveSharedFileTarget(req, res, { requireDownload: true });
  if (!target) return;

  const { share, resolved, stats, context } = target;
  if (stats.isDirectory()) {
    // A folder leaving as a zip is a download like any other.
    await trackShareDownload(share.id, { ipAddress: req.ip });
    await recordShareDownload({ share, resolved, req });
    await streamResolvedDirectoryZip({
      absolutePath: resolved.absolutePath,
      logicalPath: resolved.relativePath,
      context,
      archiveName:
        path.basename(resolved.absolutePath) ||
        share.label ||
        path.basename(share.sourcePath || '') ||
        'download',
      res,
    });
    return;
  }

  await trackShareDownload(share.id, { ipAddress: req.ip });
  await recordShareDownload({ share, resolved, req });
  await streamResolvedFile({ absolutePath: resolved.absolutePath, stats, mode, req, res });
};

/**
 * GET /api/share/:token/file/* - Open a shared file directly.
 *
 * This keeps the same share rules as the Web UI but streams the target file
 * itself, letting the browser preview supported formats or download others.
 */
router.get('/:token/file', asyncHandler(handleDirectFileRequest));
router.get('/:token/file/{*splat}', asyncHandler(handleDirectFileRequest));

/**
 * GET /api/share/:token/editor/* — read a shared text file, to edit it.
 *
 * The same rules as the direct file, and the same answer the editor gets
 * inside the application: the text, what it is called, and what this visitor
 * may do with it.
 */
const handleSharedEditorRequest = async (req, res) => {
  const target = await resolveSharedFileTarget(req, res, { allowSharedFileName: true });
  if (!target) return;

  const { share, innerPath, accessInfo, resolved } = target;
  const name = path.basename(resolved.absolutePath);
  const canDownload = Boolean(accessInfo.canDownload);
  const canWrite = Boolean(accessInfo.canWrite);

  await sendTextFile(req, res, {
    absolutePath: resolved.absolutePath,
    // What the answer says besides the text is part of its identity: a share
    // turned read-only must never be answered 304 to an editor that still
    // offers to save, nor a renamed file under its old name.
    describe: { name, path: innerPath, canDownload, canWrite },
    headers: { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' },
    // A revalidation is still somebody opening the file.
    onAnswer: () => trackShareAccess(share.id, { ipAddress: clientAddress(req) }),
    render: ({ text }) => ({ name, path: innerPath, content: text, canDownload, canWrite }),
  });
};

router.get('/:token/editor', asyncHandler(handleSharedEditorRequest));
router.get('/:token/editor/{*splat}', asyncHandler(handleSharedEditorRequest));

/**
 * PUT /api/share/:token/editor/* — save it back, when the link allows writing.
 */
const handleSharedEditorSaveRequest = async (req, res) => {
  const target = await resolveSharedFileTarget(req, res, {
    requireWrite: true,
    allowSharedFileName: true,
  });
  if (!target) return;

  const { share, resolved } = target;
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    throw new ValidationError('Text editor content must be a string.');
  }
  // The editor's own text validation before anything is written, so a writable
  // share cannot be used to modify a directory, a binary or an oversized file.
  // It also says what the file is written in, so the save keeps that.
  const { encoding } = await readTextFileHead(resolved.absolutePath);
  const payload = encodeText(content, encoding);
  if (payload.length > MAX_EDITOR_FILE_SIZE) {
    throw new ValidationError('This file is too large to save in the text editor.');
  }

  // Written beside the file and renamed over it, like every other save, so what
  // a visitor replaces is kept as a version for the owner.
  await versions.saveFile(
    resolved.absolutePath,
    (temporaryPath) => fs.writeFile(temporaryPath, payload, { flag: 'wx' }),
    {
      author: versions.authorOf({ user: req.user, guestSession: req.guestSession || {} }),
      source: 'share-editor',
    }
  );

  await trackShareAccess(share.id);
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.json({ success: true });
};

router.put('/:token/editor', asyncHandler(handleSharedEditorSaveRequest));
router.put('/:token/editor/{*splat}', asyncHandler(handleSharedEditorSaveRequest));

/**
 * GET /api/share/:token/browse/* - Browse share contents
 *
 * For directory shares, returns the contents of the directory.
 * For file shares, treats the share as a virtual one-item directory
 * and returns a single item representing the shared file.
 *
 * Response shape matches /api/browse:
 * {
 *   items: [...],
 *   access: { canRead, canWrite, canUpload, canDelete, canShare, canDownload },
 *   path: 'share/<token>/<innerPath>'
 * }
 */
router.get(
  '/:token/browse/{*splat}',
  asyncHandler(async (req, res) => {
    const shareToken = req.params.token;
    const innerPath = (req.params.splat || []).join('/');

    const logicalPath = innerPath ? `share/${shareToken}/${innerPath}` : `share/${shareToken}`;

    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, logicalPath);

    if (!accessInfo || !accessInfo.canAccess || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied');
    }

    if (!(await pathExists(resolved.absolutePath))) {
      throw new NotFoundError('Path not found');
    }

    const stats = await fs.stat(resolved.absolutePath);

    // Determine thumbnail settings
    const settings = await getSettings();
    const userSettings = req.user?.id ? await getUserSettings(req.user.id) : {};
    const thumbsEnabled = settings?.thumbnails?.enabled !== false;
    const includeHiddenFiles = userSettings?.showHiddenFiles === true;

    // Directory share or navigating inside a directory share
    if (stats.isDirectory()) {
      const shareCache = new Map();
      if (resolved?.shareInfo?.shareToken) {
        // shareInfo on resolved is the full share object
        shareCache.set(resolved.shareInfo.shareToken, resolved.shareInfo);
      }
      const userVolumeCache = new Map();
      const items = await listDirectoryItems({
        absoluteDir: resolved.absolutePath,
        parentLogicalPath: resolved.relativePath,
        context,
        thumbsEnabled,
        excludeDownloadArtifacts: false,
        includeHiddenFiles,
        access: settings?.access || null,
        shareCache,
        userVolumeCache,
        itemExtras: () => ({
          access: {
            canRead: true,
            canWrite: accessInfo.canWrite,
            canDelete: accessInfo.canDelete,
            canShare: false,
            canDownload: true,
          },
        }),
      });

      const response = {
        items,
        access: {
          canRead: accessInfo.canRead,
          canWrite: accessInfo.canWrite,
          canUpload: accessInfo.canUpload,
          canDelete: accessInfo.canDelete,
          canShare: false,
          canDownload: accessInfo.canDownload,
        },
        current: {
          isDirectory: true,
        },
        path: resolved.relativePath,
      };

      // Add share metadata for breadcrumb display
      if (resolved?.shareInfo) {
        const share = resolved.shareInfo;
        const pathParts = (share.sourcePath || '').split('/').filter(Boolean);
        response.shareInfo = {
          label: share.label,
          sourceFolderName: pathParts[pathParts.length - 1] || '',
        };
      }

      return res.json(response);
    }

    // File share (virtual one-item directory)
    const name = path.basename(resolved.absolutePath);
    const ext = path.extname(name).slice(1).toLowerCase();
    const kind = ext.length > 10 ? 'unknown' : ext || 'unknown';

    const item = {
      name,
      path: resolved.relativePath,
      dateModified: stats.mtime,
      size: stats.size,
      kind,
      access: {
        canRead: true,
        canWrite: accessInfo.canWrite,
        canDelete: accessInfo.canDelete,
        canShare: false,
        canDownload: true,
      },
    };

    if (
      thumbsEnabled &&
      !stats.isDirectory() &&
      kind !== 'pdf' &&
      extensions.previewable.has(ext)
    ) {
      item.supportsThumbnail = true;
    }

    const response = {
      items: [item],
      access: {
        canRead: accessInfo.canRead,
        canWrite: accessInfo.canWrite,
        canUpload: false,
        canDelete: accessInfo.canDelete,
        canShare: false,
        canDownload: accessInfo.canDownload,
      },
      current: {
        isDirectory: false,
      },
      path: resolved.relativePath,
    };

    // Add share metadata for breadcrumb display
    if (resolved?.shareInfo) {
      const share = resolved.shareInfo;
      const pathParts = (share.sourcePath || '').split('/').filter(Boolean);
      response.shareInfo = {
        label: share.label,
        sourceFolderName: pathParts[pathParts.length - 1] || '',
      };
    }

    return res.json(response);
  })
);

module.exports = router;
