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

router.get(
  '/browse/*',
  asyncHandler(async (req, res) => {
    // Listings carry transient information such as active OnlyOffice sessions.
    // Keep browser and proxy caches from serving an out-of-date directory view.
    res.setHeader('Cache-Control', 'private, no-store');

    const settings = await getSettings();
    const userSettings = req.user?.id ? await getUserSettings(req.user.id) : {};
    const thumbsEnabled =
      env.THUMBNAILS_ENABLED !== false && settings?.thumbnails?.enabled !== false;
    const includeHiddenFiles = userSettings?.showHiddenFiles === true;
    const rawPath = req.params[0] || '';
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
