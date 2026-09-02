const express = require('express');
const {
  getPublicSettings,
  getSettingsForUser,
  setUserSetting,
  setUserFolderSort,
  setUserFolderView,
  setSystemSetting,
  getSettings,
  WRITABLE_USER_SETTINGS,
} = require('../services/settingsService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const folderSizeManager = require('../services/folderSizeManager');
const searchIndexManager = require('../services/searchIndexManager');

const router = express.Router();

const DEFAULT_LOGO_URL = '/logo.svg';

const deleteCustomLogoFiles = async () => {
  const configDir = process.env.CONFIG_DIR || '/config';
  const logoDir = path.join(configDir, 'logos');
  const candidates = ['custom-logo.svg', 'custom-logo.png', 'custom-logo.jpg'];

  await Promise.all(
    candidates.map(async (filename) => {
      const filePath = path.join(logoDir, filename);
      try {
        await fs.unlink(filePath);
        logger.info('Deleted custom logo file', { filename });
      } catch (error) {
        if (error && error.code === 'ENOENT') return;
        logger.warn('Failed to delete custom logo file', { filename, error: error?.message });
      }
    })
  );
};

// Configure multer for logo uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/svg+xml', 'image/png', 'image/jpeg'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only SVG, PNG, and JPG are allowed.'));
    }
  },
});

/**
 * GET /api/branding
 * Returns public branding settings (no auth required)
 * Used for displaying branding on login page and public pages
 */
router.get(
  '/branding',
  asyncHandler(async (req, res) => {
    const publicSettings = await getPublicSettings();
    res.json(publicSettings.branding);
  })
);

/**
 * GET /api/settings
 * Returns settings based on user role:
 * - No auth: public settings (branding only)
 * - Authenticated user: branding + user settings
 * - Admin: branding + user settings + system settings
 */
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const settings = await getSettingsForUser(req.user);
    res.json(settings);
  })
);

/**
 * POST /api/settings/upload-logo
 * Upload a custom logo file (admin only)
 */
router.post(
  '/settings/upload-logo',
  ensureAdmin,
  upload.single('logo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const configDir = process.env.CONFIG_DIR || '/config';
      const logoDir = path.join(configDir, 'logos');

      // Create logos directory if it doesn't exist
      await fs.mkdir(logoDir, { recursive: true });

      // Generate filename based on MIME type
      let filename = 'custom-logo';
      if (req.file.mimetype === 'image/svg+xml') {
        filename += '.svg';
      } else if (req.file.mimetype === 'image/png') {
        filename += '.png';
      } else if (req.file.mimetype === 'image/jpeg') {
        filename += '.jpg';
      }

      const logoPath = path.join(logoDir, filename);

      // Write file to disk
      await fs.writeFile(logoPath, req.file.buffer);

      logger.info('Logo uploaded successfully', {
        filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });

      // Return the URL path for the uploaded logo
      const logoUrl = `/static/logos/${filename}`;
      res.json({ logoUrl });
    } catch (error) {
      logger.error('Logo upload error', { error: error.message });
      res.status(500).json({ error: 'Failed to save logo' });
    }
  })
);

/**
 * PATCH /api/settings
 * Update settings with partial data
 * - Users can update their own user settings (user.*)
 * - Admins can update system settings (thumbnails, access, branding)
 */
/**
 * Keep the fields of a section that arrived in a shape worth storing.
 *
 * A field nobody sent is not a field set to nothing, and a size that is not a
 * number is a size nobody chose: both are left out, so the stored value stays
 * what it was rather than becoming something the caller never asked for.
 */
const keepValid = (section, fields) => {
  const update = {};
  for (const [name, isAcceptable] of Object.entries(fields)) {
    if (isAcceptable(section[name])) update[name] = section[name];
  }
  return update;
};

const isNumber = (value) => Number.isFinite(value);
const isBoolean = (value) => typeof value === 'boolean';
const isText = (value) => typeof value === 'string';
const isPresent = (value) => value != null;

/**
 * Merge an update over what is stored, and give back the whole section.
 *
 * @returns {Promise<object|null>} null when there was nothing to change, so a
 *   caller can tell "no valid field" from "field set to its current value".
 */
const mergeSection = async (category, key, update) => {
  if (Object.keys(update).length === 0) return null;
  const current = await getSettings();
  const merged = { ...current[key], ...update };
  await setSystemSetting(category, key, merged);
  return merged;
};

/** A person's own preferences, which they may change whatever their role. */
const applyUserPreferences = async (user, section) => {
  const updates = {};

  for (const [key, value] of Object.entries(section)) {
    if (key === 'folderSort') {
      const folderSorts = await setUserFolderSort(user.id, value?.path, value?.sort);
      if (folderSorts) updates.folderSorts = folderSorts;
    } else if (key === 'folderView') {
      const folderViews = await setUserFolderView(user.id, value?.path, value?.view);
      if (folderViews) updates.folderViews = folderViews;
    } else if (WRITABLE_USER_SETTINGS.has(key)) {
      updates[key] = await setUserSetting(user.id, key, value);
    }
  }

  return Object.keys(updates).length > 0 ? updates : null;
};

const applyThumbnails = (section) =>
  mergeSection(
    'system',
    'thumbnails',
    keepValid(section, {
      enabled: isPresent,
      size: isNumber,
      quality: isNumber,
      concurrency: isNumber,
    })
  );

const applyUploads = (section) =>
  mergeSection(
    'system',
    'uploads',
    keepValid(section, {
      chunkedEnabled: isBoolean,
      chunkedAutoFallback: isBoolean,
      chunkSizeBytes: isNumber,
    })
  );

const applyBranding = (section) =>
  mergeSection(
    'branding',
    'branding',
    keepValid(section, { appName: isText, appLogoUrl: isText, showPoweredBy: isBoolean })
  );

/** Access rules replace the list rather than merging into it. */
const applyAccess = async (section) => {
  if (!Array.isArray(section.rules)) return null;
  await setSystemSetting('system', 'access', { rules: section.rules });
  return { rules: section.rules };
};

/**
 * A list of folders a background worker is told to leave alone.
 *
 * Stored and then handed to the worker, which answers with the list it is
 * actually applying — the stored one plus whatever the environment set, which
 * an administrator cannot remove from here.
 */
const applyExclusions = async (key, manager, section) => {
  if (!Array.isArray(section.excludedPaths)) return null;

  const current = await getSettings();
  const saved = await setSystemSetting('system', key, {
    ...current[key],
    excludedPaths: section.excludedPaths,
  });
  const applied = await manager.setAdminExclusions(saved.excludedPaths);

  return {
    excludedPaths: applied.excludedPaths,
    environmentExcludedPaths: applied.environmentExcludedPaths,
  };
};

/** Every section only an administrator may write, and what writes it. */
const SYSTEM_SECTIONS = {
  thumbnails: applyThumbnails,
  access: applyAccess,
  uploads: applyUploads,
  branding: applyBranding,
  folderSize: (section) => applyExclusions('folderSize', folderSizeManager, section),
  searchIndex: (section) => applyExclusions('searchIndex', searchIndexManager, section),
};

/**
 * A custom logo that has been reset to the default leaves a file behind, which
 * nothing else will ever serve or delete.
 */
const forgetCustomLogo = async (branding) => {
  const requested = typeof branding?.appLogoUrl === 'string' ? branding.appLogoUrl.trim() : null;
  if (requested === '' || requested === DEFAULT_LOGO_URL) await deleteCustomLogoFiles();
};

router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const user = req.user;
    const isAdmin = user && Array.isArray(user.roles) && user.roles.includes('admin');

    // Asked before anything is written, not after. The user section used to be
    // applied first and the refusal raised afterwards, so a payload carrying
    // both a preference and a system setting answered 403 with the preference
    // already saved — a request reported as refused that had changed something.
    const wantsSystemSettings = Object.keys(SYSTEM_SECTIONS).some((name) => payload[name]);
    if (!isAdmin && wantsSystemSettings) {
      return res.status(403).json({ error: 'Admin access required for system settings.' });
    }

    if (payload.user && typeof payload.user === 'object' && user?.id) {
      await applyUserPreferences(user, payload.user);
    }

    if (isAdmin) {
      for (const [name, apply] of Object.entries(SYSTEM_SECTIONS)) {
        const section = payload[name];
        if (section && typeof section === 'object') await apply(section);
      }
      await forgetCustomLogo(payload.branding);
    }

    // Read back rather than assembled from what was written: the stored value
    // is sanitised on its way out, so what the caller applies to its own state
    // is what a later request would read.
    const finalSettings = await getSettingsForUser(user);
    res.json(finalSettings);
  })
);

module.exports = router;
