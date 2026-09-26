const express = require('express');
const {
  getPublicSettings,
  getSettingsForUser,
  setUserSetting,
  USER_SETTING_KEYS,
  setSystemSetting,
  getSettings,
} = require('../services/settingsService');
const activityLog = require('../services/activityLog');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const { checkRulePath } = require('../services/accessControlService');
const { ValidationError } = require('../errors/AppError');
const folderSizeManager = require('../services/folderSizeManager');
const searchIndexManager = require('../services/searchIndexManager');
const asyncHandler = require('../utils/asyncHandler');
const multer = require('multer');
const { explainMultipartRefusals, describeBytes } = require('../middleware/multipartRefusals');
const { replaceLogo, forgetReplacedLogo } = require('../services/brandingLogo');

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

// Middleware to check if user is admin
const keepValid = (section, fields) => {
  const update = {};
  for (const [name, isAcceptable] of Object.entries(fields)) {
    if (isAcceptable(section[name])) update[name] = section[name];
  }
  return update;
};

const isBoolean = (value) => typeof value === 'boolean';

// An application name of spaces is no name: the header and the sign-in page showed
// nothing where it belonged.
const isName = (value) => typeof value === 'string' && value.trim() !== '';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

// Configure multer for logo uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/svg+xml', 'image/png', 'image/jpeg'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // A ValidationError and not a plain Error: the wrong kind of file is the
      // request's fault, and a plain Error reached the client as a 500.
      cb(new ValidationError('Invalid file type. Only SVG, PNG, and JPG are allowed.'));
    }
  },
});

const acceptLogo = explainMultipartRefusals(upload.single('logo'), {
  LIMIT_FILE_SIZE: `A logo can be at most ${describeBytes(LOGO_MAX_BYTES)}.`,
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
 * The rest of the branding, sent in the same form as a logo so that both are
 * saved together. Held to the rules a PATCH holds it to; the logo address is
 * the uploaded file's, whatever was sent.
 */
const brandingSentWithLogo = (field) => {
  if (field === undefined) return {};
  let section;
  try {
    section = JSON.parse(field);
  } catch {
    section = null;
  }
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new ValidationError('The branding sent with the logo is not JSON.');
  }
  return keepValid(section, { appName: isName, showPoweredBy: isBoolean });
};

/**
 * POST /api/settings/upload-logo
 *
 * Make an image the logo (admin only), with any other branding sent in the
 * `branding` field. The upload is the save: the logo in use is replaced only
 * once the new one is written and stored, and a failure leaves it as it was.
 * Answers the settings, as a PATCH does, and the new logo's address.
 */
router.post(
  '/settings/upload-logo',
  ensureAdmin,
  acceptLogo,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('No file uploaded');

    const { logoUrl } = await replaceLogo(req.file, brandingSentWithLogo(req.body?.branding));

    const settings = await getSettingsForUser(req.user);
    res.json({ ...settings, logoUrl });
  })
);

/**
 * POST /api/settings/access/check-paths
 *
 * What each path of a rule names on the disk (admin only), for the rule editor
 * to warn about one that names nothing and offer the folder that was probably
 * meant. Nothing is stored or refused here: see `checkRulePath`.
 */
const MAX_CHECKED_PATHS = 200;

router.post(
  '/settings/access/check-paths',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths)) throw new ValidationError('paths must be a list.');
    if (paths.length > MAX_CHECKED_PATHS) {
      throw new ValidationError(`At most ${MAX_CHECKED_PATHS} paths are checked at once.`);
    }
    res.json({ paths: await Promise.all(paths.map((entry) => checkRulePath(entry))) });
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

      // The folders each background worker leaves alone. The list is stored
      // and handed to the worker, which answers with the list it is really
      // applying — the stored one plus whatever the environment set, which an
      // administrator cannot take away from here.
      for (const [key, manager] of [
        ['folderSize', folderSizeManager],
        ['searchIndex', searchIndexManager],
      ]) {
        const section = payload[key];
        if (!section || typeof section !== 'object') continue;
        if (!Array.isArray(section.excludedPaths)) continue;
        const current = await getSettings();
        const merged = await setSystemSetting('system', key, {
          ...current[key],
          excludedPaths: section.excludedPaths,
        });
        await manager.setAdminExclusions(merged.excludedPaths);
        systemUpdates[key] = merged;
      }

      // Branding settings
      let previousLogoUrl;
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
          previousLogoUrl = current.branding?.appLogoUrl ?? null;
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

      // The logo that was replaced is forgotten, and only once nothing points at it
      // any more. Removing the files under a fixed name meant a logo could not be
      // changed back, and a branding change that failed halfway took the logo in use
      // with it.
      if (previousLogoUrl !== undefined) {
        const settingsNow = await getSettings();
        await forgetReplacedLogo(previousLogoUrl, settingsNow.branding?.appLogoUrl);
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
