const express = require('express');
const {
  getPublicSettings,
  getSettingsForUser,
  setUserSetting,
  USER_SETTING_KEYS,
  setSystemSetting,
  getSettings,
} = require('../services/settingsService');
const logger = require('../utils/logger');
const activityLog = require('../services/activityLog');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const asyncHandler = require('../utils/asyncHandler');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');

/**
 * A number somebody chose.
 *
 * Every numeric setting here has a floor above zero, and every one of them is
 * a field on a form: emptied, it arrives as 0. Stored, the sanitizer lifts it
 * to the floor — so clearing the trash retention used to leave a trash that
 * keeps one day and sweeps everything older within the hour, and clearing the
 * share of a volume left one percent. Nothing arriving means nothing chosen,
 * and what is stored stays.
 *
 * One reading for all of them rather than a condition per field, so a section
 * added later cannot be the one that forgot.
 */
const chosenNumber = (value) => Number.isFinite(value) && value > 0;

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

// Middleware to check if user is admin
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
router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const user = req.user;
    const isAdmin = user && Array.isArray(user.roles) && user.roles.includes('admin');
    const updated = {};

    // User settings (all authenticated users can update)
    if (payload.user && typeof payload.user === 'object' && user && user.id) {
      const userUpdates = {};
      for (const [key, value] of Object.entries(payload.user)) {
        // Which keys are preferences is the settings service's to say: this
        // route used to keep a second list of its own, and a preference added
        // to one and not the other was silently dropped here.
        if (USER_SETTING_KEYS.has(key)) {
          userUpdates[key] = await setUserSetting(user.id, key, value);
        }
      }
      if (Object.keys(userUpdates).length > 0) {
        updated.user = userUpdates;
      }
    }

    // System settings (admin only)
    if (isAdmin) {
      const systemUpdates = {};

      // Thumbnails settings
      if (payload.thumbnails && typeof payload.thumbnails === 'object') {
        const thumbnailsUpdate = {};
        if (payload.thumbnails.enabled != null) {
          thumbnailsUpdate.enabled = Boolean(payload.thumbnails.enabled);
        }
        if (chosenNumber(payload.thumbnails.size)) {
          thumbnailsUpdate.size = payload.thumbnails.size;
        }
        if (chosenNumber(payload.thumbnails.quality)) {
          thumbnailsUpdate.quality = payload.thumbnails.quality;
        }
        if (chosenNumber(payload.thumbnails.concurrency)) {
          thumbnailsUpdate.concurrency = payload.thumbnails.concurrency;
        }
        if (Object.keys(thumbnailsUpdate).length > 0) {
          const current = await getSettings();
          await setSystemSetting('system', 'thumbnails', {
            ...current.thumbnails,
            ...thumbnailsUpdate,
          });
          systemUpdates.thumbnails = { ...current.thumbnails, ...thumbnailsUpdate };
        }
      }

      // Access control rules, and whether they hold administrators. The two are
      // saved apart on the settings page, so each is merged over what is stored
      // rather than replacing the section: saving the rules used to drop the
      // setting above them, and saving the setting used to drop the rules.
      if (payload.access && typeof payload.access === 'object') {
        const accessUpdate = {};
        if (Array.isArray(payload.access.rules)) accessUpdate.rules = payload.access.rules;
        if (typeof payload.access.applyToAdmins === 'boolean') {
          accessUpdate.applyToAdmins = payload.access.applyToAdmins;
        }
        if (Object.keys(accessUpdate).length > 0) {
          const current = await getSettings();
          const merged = await setSystemSetting('system', 'access', {
            ...current.access,
            ...accessUpdate,
          });
          systemUpdates.access = merged;
        }
      }

      // Trash settings: only the fields that arrived in a usable shape are
      // merged over what is stored; setSystemSetting sanitizes and clamps them.
      if (payload.trash && typeof payload.trash === 'object') {
        const trashUpdate = {};
        if (typeof payload.trash.enabled === 'boolean') {
          trashUpdate.enabled = payload.trash.enabled;
        }
        if (chosenNumber(payload.trash.retentionDays)) {
          trashUpdate.retentionDays = payload.trash.retentionDays;
        }
        if (chosenNumber(payload.trash.maxPercent)) {
          trashUpdate.maxPercent = payload.trash.maxPercent;
        }
        if (payload.trash.maxBytes === null || chosenNumber(payload.trash.maxBytes)) {
          trashUpdate.maxBytes = payload.trash.maxBytes;
        }
        if (Object.keys(trashUpdate).length > 0) {
          const current = await getSettings();
          const merged = await setSystemSetting('system', 'trash', {
            ...current.trash,
            ...trashUpdate,
          });
          systemUpdates.trash = merged;
        }
      }

      // Upload settings: whether uploads go out in chunks, and how big one is.
      if (payload.uploads && typeof payload.uploads === 'object') {
        const uploadsUpdate = {};
        if (typeof payload.uploads.chunkedEnabled === 'boolean') {
          uploadsUpdate.chunkedEnabled = payload.uploads.chunkedEnabled;
        }
        if (chosenNumber(payload.uploads.chunkSizeBytes)) {
          uploadsUpdate.chunkSizeBytes = payload.uploads.chunkSizeBytes;
        }
        if (Object.keys(uploadsUpdate).length > 0) {
          const current = await getSettings();
          const merged = await setSystemSetting('system', 'uploads', {
            ...current.uploads,
            ...uploadsUpdate,
          });
          systemUpdates.uploads = merged;
        }
      }

      // File-version settings: only the fields that arrived usable are merged;
      // setSystemSetting sanitizes and keeps them consistent.
      if (payload.versions && typeof payload.versions === 'object') {
        const versionsUpdate = {};
        if (typeof payload.versions.enabled === 'boolean') {
          versionsUpdate.enabled = payload.versions.enabled;
        }
        for (const key of [
          'keepAllHours',
          'hourlyDays',
          'dailyDays',
          'maxPerFile',
          'sessionCheckpointMinutes',
        ]) {
          if (chosenNumber(payload.versions[key])) versionsUpdate[key] = payload.versions[key];
        }
        if (Object.keys(versionsUpdate).length > 0) {
          const current = await getSettings();
          const merged = await setSystemSetting('system', 'versions', {
            ...current.versions,
            ...versionsUpdate,
          });
          systemUpdates.versions = merged;
        }
      }

      // Activity log settings: the switch, and how long a line is kept.
      if (payload.activity && typeof payload.activity === 'object') {
        const activityUpdate = {};
        if (typeof payload.activity.enabled === 'boolean') {
          activityUpdate.enabled = payload.activity.enabled;
        }
        if (chosenNumber(payload.activity.retentionDays)) {
          activityUpdate.retentionDays = payload.activity.retentionDays;
        }
        if (Object.keys(activityUpdate).length > 0) {
          const current = await getSettings();
          const merged = await setSystemSetting('system', 'activity', {
            ...current.activity,
            ...activityUpdate,
          });
          systemUpdates.activity = merged;
        }
      }

      // Branding settings
      if (payload.branding && typeof payload.branding === 'object') {
        const brandingUpdate = {};
        if (typeof payload.branding.appName === 'string') {
          brandingUpdate.appName = payload.branding.appName;
        }
        if (typeof payload.branding.appLogoUrl === 'string') {
          brandingUpdate.appLogoUrl = payload.branding.appLogoUrl;
        }
        if (typeof payload.branding.showPoweredBy === 'boolean') {
          brandingUpdate.showPoweredBy = payload.branding.showPoweredBy;
        }
        if (Object.keys(brandingUpdate).length > 0) {
          const current = await getSettings();
          await setSystemSetting('branding', 'branding', {
            ...current.branding,
            ...brandingUpdate,
          });
          systemUpdates.branding = { ...current.branding, ...brandingUpdate };
        }
      }

      if (Object.keys(systemUpdates).length > 0) {
        Object.assign(updated, systemUpdates);
        // Which settings, not what they were set to: values belong in the
        // settings, and some of them are somebody's business alone.
        await activityLog.record({
          action: 'admin.settings',
          user,
          detail: { sections: Object.keys(systemUpdates) },
          req,
        });
      }

      // Handle logo deletion if resetting to default
      const requestedLogoUrl =
        typeof payload.branding?.appLogoUrl === 'string'
          ? payload.branding.appLogoUrl.trim()
          : null;
      const resetToDefault =
        requestedLogoUrl != null &&
        (requestedLogoUrl === '' || requestedLogoUrl === DEFAULT_LOGO_URL);
      if (resetToDefault) {
        await deleteCustomLogoFiles();
      }
    } else if (payload.thumbnails || payload.access || payload.branding) {
      // Non-admin trying to update system settings
      return res.status(403).json({ error: 'Admin access required for system settings.' });
    }

    // Return updated settings
    const finalSettings = await getSettingsForUser(user);
    res.json(finalSettings);
  })
);

module.exports = router;
