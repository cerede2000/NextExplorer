const express = require('express');
const {
  getPublicSettings,
  getSettingsForUser,
  setUserSetting,
  setUserFolderSort,
  setUserFolderView,
  setSystemSetting,
  mergeSystemSection,
  replaceBranding,
  WRITABLE_USER_SETTINGS,
} = require('../services/settingsService');
const { forgetReplacedLogo, replaceLogo } = require('../services/brandingLogo');
const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const multer = require('multer');
const { ValidationError } = require('../errors/AppError');
const { describeBytes, explainMultipartRefusals } = require('../middleware/multipartRefusals');
const folderSizeManager = require('../services/folderSizeManager');
const searchIndexManager = require('../services/searchIndexManager');

const router = express.Router();

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

// A size or a count of nothing, or of less than nothing, is what an emptied or
// mistyped field sends, not a value anyone chose. The service would bring it up
// to its lowest bound — a chunk size of 0 became 1 MiB — which replaced what
// was stored with something nobody asked for. A positive value outside the
// bounds is still brought within them there.
const isPositiveNumber = (value) => Number.isFinite(value) && value > 0;

// An application name of spaces is no name: the header and the sign-in page
// showed nothing where it belonged.
const isName = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Merge an update over what is stored, and give back the whole section.
 *
 * The merge is the service's, which reads the stored section and writes it
 * back without yielding in between. Merging over the settings read at the
 * start of the request, as this did, left two awaits between the read and the
 * write: two saves of one section at once both started from the same stored
 * value, and the second wrote over the first's field while telling the person
 * who set it that it was saved. Branding already had its own reason for a
 * read and a write in one step; every section has this one.
 *
 * @returns {Promise<object|null>} null when there was nothing to change, so a
 *   caller can tell "no valid field" from "field set to its current value".
 */
const mergeSection = async (category, key, update) => {
  if (Object.keys(update).length === 0) return null;
  return mergeSystemSection(category, key, update);
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
      // Anything but a boolean used to be read as "on": "false" switched
      // thumbnails on for everybody.
      enabled: isBoolean,
      size: isPositiveNumber,
      quality: isPositiveNumber,
      concurrency: isPositiveNumber,
    })
  );

const applyUploads = (section) =>
  mergeSection(
    'system',
    'uploads',
    keepValid(section, {
      chunkedEnabled: isBoolean,
      chunkedAutoFallback: isBoolean,
      chunkSizeBytes: isPositiveNumber,
    })
  );

const isNumberOrNull = (value) => value === null || Number.isFinite(value);

const applyTrash = (section) =>
  mergeSection(
    'system',
    'trash',
    keepValid(section, {
      enabled: isBoolean,
      retentionDays: isNumber,
      maxPercent: isNumber,
      maxBytes: isNumberOrNull,
    })
  );

const applyVersions = (section) =>
  mergeSection(
    'system',
    'versions',
    keepValid(section, {
      enabled: isBoolean,
      keepAllHours: isNumber,
      hourlyDays: isNumber,
      dailyDays: isNumber,
      maxPerFile: isNumber,
      sessionCheckpointMinutes: isNumber,
    })
  );

/**
 * Branding is read and written in one step rather than merged over the
 * settings read at the start of the request, because a logo it replaces is
 * then removed: reset to the default, or pointed elsewhere, the old file would
 * otherwise stay behind with nothing to serve or remove it.
 */
const applyBranding = async (section) => {
  const update = keepValid(section, {
    appName: isName,
    appLogoUrl: isText,
    showPoweredBy: isBoolean,
  });
  if (Object.keys(update).length === 0) return null;

  const { previous, current } = await replaceBranding(update);
  await forgetReplacedLogo(previous.appLogoUrl, current.appLogoUrl);
  return current;
};

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

  const saved = await mergeSection('system', key, { excludedPaths: section.excludedPaths });
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
  trash: applyTrash,
  versions: applyVersions,
  branding: applyBranding,
  folderSize: (section) => applyExclusions('folderSize', folderSizeManager, section),
  searchIndex: (section) => applyExclusions('searchIndex', searchIndexManager, section),
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
    }

    // Read back rather than assembled from what was written: the stored value
    // is sanitised on its way out, so what the caller applies to its own state
    // is what a later request would read.
    const finalSettings = await getSettingsForUser(user);
    res.json(finalSettings);
  })
);

module.exports = router;
