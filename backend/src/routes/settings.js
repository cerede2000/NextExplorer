const express = require('express');
const {
  getPublicSettings,
  getSettingsForUser,
  setUserSetting,
  setUserFolderSort,
  setUserFolderView,
  checkSystemSection,
  mergeSystemSection,
  replaceBranding,
  WRITABLE_USER_SETTINGS,
} = require('../services/settingsService');
const { forgetReplacedLogo, replaceLogo } = require('../services/brandingLogo');
const activityLog = require('../services/activityLog');
const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const multer = require('multer');
const { ValidationError } = require('../errors/AppError');
const { describeBytes, explainMultipartRefusals } = require('../middleware/multipartRefusals');
const folderSizeManager = require('../services/folderSizeManager');
const searchIndexManager = require('../services/searchIndexManager');
const featureSwitches = require('../services/featureSwitches');
const { checkRulePath } = require('../services/accessControlService');

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

/**
 * A section checked in one step and written in another.
 *
 * Both halves exist because one save carries several sections: a refusal in
 * the third must not leave the first two stored. `check` answers what is to be
 * written, or null when the section sends nothing this route stores, and it is
 * where a refusal comes from. `write` stores it, and cannot refuse.
 */
const merging = (key, fields) => ({
  check: (section) => keepValid(section, fields),
  write: (update) => mergeSection('system', key, update),
});

const thumbnailsSection = merging('thumbnails', {
  // Anything but a boolean used to be read as "on": "false" switched
  // thumbnails on for everybody.
  enabled: isBoolean,
  size: isPositiveNumber,
  quality: isPositiveNumber,
  concurrency: isPositiveNumber,
});

const uploadsSection = merging('uploads', {
  chunkedEnabled: isBoolean,
  chunkedAutoFallback: isBoolean,
  chunkSizeBytes: isPositiveNumber,
});

// The trash's size cap is the one field where nothing is a value: null removes
// the cap. Zero is not that — it is what an emptied field sends, and the
// service read it as "no cap given" and put the default back.
const isPositiveNumberOrNull = (value) => value === null || isPositiveNumber(value);

// A retention of no days, or of fewer than none, is what an emptied or
// mistyped field sends. The service brought each up to its lowest bound — a
// retention of 0 became one day, of -5 became one day — in place of the ninety
// the administrator had. The settings page refuses them with the same bounds;
// this is what an API client used to see instead.
const trashSection = merging('trash', {
  enabled: isBoolean,
  retentionDays: isPositiveNumber,
  maxPercent: isPositiveNumber,
  maxBytes: isPositiveNumberOrNull,
});

const versionsSection = merging('versions', {
  enabled: isBoolean,
  keepAllHours: isPositiveNumber,
  hourlyDays: isPositiveNumber,
  dailyDays: isPositiveNumber,
  maxPerFile: isPositiveNumber,
  sessionCheckpointMinutes: isPositiveNumber,
});

const activitySection = merging('activity', {
  enabled: isBoolean,
  retentionDays: isPositiveNumber,
});

/**
 * Branding is read and written in one step rather than merged over the
 * settings read at the start of the request, because a logo it replaces is
 * then removed: reset to the default, or pointed elsewhere, the old file would
 * otherwise stay behind with nothing to serve or remove it.
 */
const brandingSection = {
  check: (section) => {
    const update = keepValid(section, {
      appName: isName,
      appLogoUrl: isText,
      showPoweredBy: isBoolean,
    });
    return Object.keys(update).length > 0 ? update : null;
  },
  write: async (update) => {
    const { previous, current } = await replaceBranding(update);
    await forgetReplacedLogo(previous.appLogoUrl, current.appLogoUrl);
  },
};

/**
 * Access rules replace the list rather than merging into it, and they are the
 * one section that refuses what it was sent: a rule with no folder, or a
 * permission that is not one of the three, is answered rather than dropped.
 * Which is why it is checked here, before any other section is written — a
 * list sent as something that is not a list is still dropped, as it always
 * was, because then there is nothing to store.
 *
 * The switch that holds administrators to every rule is saved from a control of
 * its own, so each half is taken only when it was sent and merged over what is
 * stored: saving the rules must not switch it off, and switching it must not
 * empty the rules.
 */
const accessSection = {
  check: (section) => {
    const update = {};
    if (Array.isArray(section.rules)) {
      update.rules = checkSystemSection('access', { rules: section.rules }).rules;
    }
    if (section.applyToAdmins !== undefined) {
      update.applyToAdmins = checkSystemSection('access', {
        applyToAdmins: section.applyToAdmins,
      }).applyToAdmins;
    }
    return Object.keys(update).length > 0 ? update : null;
  },
  write: (update) => mergeSystemSection('system', 'access', update),
};

/**
 * A background worker: the folders it leaves alone, and whether it runs.
 *
 * The list is stored and handed to the worker, which answers with the list it
 * is actually applying — the stored one plus whatever the environment set,
 * which an administrator cannot remove from here.
 *
 * The switch follows the same rule. When the environment set it, it is refused
 * rather than quietly stored: an administrator who flips a switch and sees
 * nothing happen deserves to be told which variable is in the way, and a page
 * that shows the switch locked will not send it in the first place.
 *
 * @param {string} key          the settings section
 * @param {object} manager      the worker, for its exclusions
 * @param {string} field        `enabled` or `mode`
 * @param {(value: *) => *} valid  the value to store, or undefined to refuse it
 * @param {(value: *) => Promise} apply  switch the worker to it
 * @param {string} variable     the environment variable that would lock it
 */
const background = ({ key, manager, field, valid, apply, variable }) => ({
  check: (section) => {
    const update = {};
    if (Array.isArray(section.excludedPaths)) update.excludedPaths = section.excludedPaths;

    if (Object.prototype.hasOwnProperty.call(section, field)) {
      if (featureSwitches.snapshot()[key].lockedBy) {
        throw new ValidationError(
          `${variable} is set in the environment, so this is decided there and not here.`
        );
      }
      const value = valid(section[field]);
      if (value === undefined) throw new ValidationError(`${field} is not a value ${key} takes.`);
      update[field] = value;
    }

    return Object.keys(update).length ? update : null;
  },
  write: async (update) => {
    const saved = await mergeSection('system', key, update);
    if (!saved) return false;
    if (update.excludedPaths) await manager.setAdminExclusions(saved.excludedPaths);
    if (Object.prototype.hasOwnProperty.call(update, field)) await apply(saved[field]);
    return true;
  },
});

const searchIndexSection = background({
  key: 'searchIndex',
  manager: searchIndexManager,
  field: 'enabled',
  valid: (value) => (typeof value === 'boolean' ? value : undefined),
  apply: (value) => featureSwitches.setSearchIndex(value),
  variable: 'SEARCH_INDEX',
});

const folderSizeSection = background({
  key: 'folderSize',
  manager: folderSizeManager,
  field: 'mode',
  valid: (value) => (featureSwitches.FOLDER_SIZE_MODES.includes(value) ? value : undefined),
  apply: (value) => featureSwitches.setFolderSizeMode(value),
  variable: 'FOLDER_SIZE_MODE',
});

/** Every section only an administrator may write, and what writes it. */
const SYSTEM_SECTIONS = {
  thumbnails: thumbnailsSection,
  access: accessSection,
  uploads: uploadsSection,
  trash: trashSection,
  versions: versionsSection,
  activity: activitySection,
  branding: brandingSection,
  folderSize: folderSizeSection,
  searchIndex: searchIndexSection,
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

    // Every section is checked before any of them is written. A save carrying
    // a valid section and a refused one used to store the first and then answer
    // 400: a request reported as refused that had changed something, and left
    // the page showing settings the server had only half taken.
    const toWrite = [];
    if (isAdmin) {
      for (const [name, section] of Object.entries(SYSTEM_SECTIONS)) {
        const sent = payload[name];
        if (!sent || typeof sent !== 'object') continue;
        const update = section.check(sent);
        if (update !== null) toWrite.push([name, section, update]);
      }
    }

    if (payload.user && typeof payload.user === 'object' && user?.id) {
      await applyUserPreferences(user, payload.user);
    }

    // What was stored, not what was sent: a section whose every field was
    // refused writes nothing, and a log line saying otherwise would send
    // somebody looking for a change that never happened.
    const stored = [];
    for (const [name, section, update] of toWrite) {
      if (await section.write(update)) stored.push(name);
    }
    if (stored.length) {
      // Which settings, not what they were set to: values belong in the
      // settings, and some of them are somebody's business alone.
      await activityLog.record({
        action: 'admin.settings',
        user,
        detail: { sections: stored },
        req,
      });
    }

    // Read back rather than assembled from what was written: the stored value
    // is sanitised on its way out, so what the caller applies to its own state
    // is what a later request would read.
    const finalSettings = await getSettingsForUser(user);
    res.json(finalSettings);
  })
);

module.exports = router;
