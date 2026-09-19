const express = require('express');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { pathExists } = require('../utils/fsUtils');
const env = require('../config/env');
const { getSettings, getUserSettings } = require('../services/settingsService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError } = require('../errors/AppError');

const router = express.Router();
const { resolvePathWithAccess } = require('../services/accessManager');
const { listDirectoryItems } = require('../services/directoryListingService');
const versions = require('../services/versions');
const { rightsFrom: versionRights } = versions;

/**
 * The mark that says a file has earlier versions, for a whole listing.
 *
 * Counted once for the folder rather than once per row, and only when
 * somebody asked to see it — the preference is on by default, and turning it
 * off takes the query away as well as the icon, so it costs nothing to
 * somebody who does not want it.
 *
 * The right to see a history is the row's own and not the folder's: a share
 * hands out histories only when its owner said so, and that is decided here
 * from each child's access rather than from the folder's.
 */
const versionMarks = async (directoryPath, userSettings) => {
  if (userSettings?.showVersionMarks === false) return null;

  let marks;
  try {
    marks = await versions.marksForFolder(directoryPath);
  } catch (error) {
    // A listing is not worth failing over a count. Nothing is marked, and the
    // history is still one right-click away.
    logger.warn({ err: error, directoryPath }, 'File versions were not counted for a listing');
    return null;
  }
  if (!marks || marks.size === 0) return null;

  return ({ name, stats, access }) => {
    if (!stats?.isFile()) return null;
    const mark = marks.get(name);
    if (!mark || !versionRights(access).see) return null;
    return { versions: { count: mark.versions, bytes: mark.bytes, newest: mark.newest } };
  };
};

router.get(
  '/browse/{*splat}',
  asyncHandler(async (req, res) => {
    // Listings carry transient information such as active OnlyOffice sessions.
    // Keep browser and proxy caches from serving an out-of-date directory view.
    res.setHeader('Cache-Control', 'private, no-store');

    const settings = await getSettings();
    const userSettings = req.user?.id ? await getUserSettings(req.user.id) : {};
    const thumbsEnabled =
      env.THUMBNAILS_ENABLED !== false && settings?.thumbnails?.enabled !== false;
    const includeHiddenFiles = userSettings?.showHiddenFiles === true;
    const rawPath = (req.params.splat || []).join('/');
    const inputRelativePath = normalizeRelativePath(rawPath);

    const context = { user: req.user, guestSession: req.guestSession };
    let accessInfo;
    let resolved;
    try {
      ({ accessInfo, resolved } = await resolvePathWithAccess(context, inputRelativePath));
    } catch (error) {
      logger.warn({ path: rawPath, err: error }, 'Failed to resolve browse path');
      throw new NotFoundError('Path not found.');
    }

    if (!accessInfo || !accessInfo.canAccess) {
      throw new NotFoundError(accessInfo?.denialReason || 'Access denied');
    }

    const { absolutePath: directoryPath, relativePath } = resolved;

    if (!(await pathExists(directoryPath))) {
      throw new NotFoundError('Path not found.');
    }

    const fileData = await listDirectoryItems({
      absoluteDir: directoryPath,
      parentLogicalPath: relativePath,
      context,
      thumbsEnabled,
      includeHiddenFiles,
      permissionRules: settings?.access?.rules || [],
      itemExtras: await versionMarks(directoryPath, userSettings),
    });

    const response = {
      items: fileData,
      access: {
        canRead: accessInfo.canRead,
        canWrite: accessInfo.canWrite,
        canUpload: accessInfo.canUpload,
        canDelete: accessInfo.canDelete,
        canCreateFolder: accessInfo.canCreateFolder,
        canCreateFile: accessInfo.canCreateFile,
        canShare: accessInfo.canShare,
        canDownload: accessInfo.canDownload,
        // Whether the files here show their history, which a share hands out
        // only when its owner said so.
        canSeeVersions: versionRights(accessInfo).see,
      },
      current: {
        isDirectory: true,
      },
      path: relativePath,
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

    res.json(response);
  })
);

module.exports = router;
