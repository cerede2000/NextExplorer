const { getDb } = require('./db');
const env = require('../config/env');
const { parseByteSize } = require('../utils/env');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { ruleAppliesToAdmins } = require('../utils/accessRules');
const folderSizeExclusions = require('./folderSizeExclusions');
const searchIndexExclusions = require('./searchIndexExclusions');
const storage = require('./storage/jsonStorage'); // Keep for backward compatibility fallback

const generateId = () => {
  const crypto = require('crypto');
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
};

/**
 * Sanitize thumbnail settings
 */
const sanitizeThumbnails = (thumbnails = {}) => {
  return {
    enabled: typeof thumbnails.enabled === 'boolean' ? thumbnails.enabled : true,
    size: Number.isFinite(thumbnails.size)
      ? Math.max(64, Math.min(1024, Math.floor(thumbnails.size)))
      : 200,
    quality: Number.isFinite(thumbnails.quality)
      ? Math.max(1, Math.min(100, Math.floor(thumbnails.quality)))
      : 70,
    concurrency: Number.isFinite(thumbnails.concurrency)
      ? Math.max(1, Math.min(50, Math.floor(thumbnails.concurrency)))
      : 10,
  };
};

/**
 * Sanitize access control rules
 */
const sanitizeAccessRules = (rules = []) => {
  if (!Array.isArray(rules)) return [];

  return rules
    .map((rule) => {
      if (!rule || typeof rule !== 'object') return null;

      // Validate path
      let normalizedPath;
      try {
        normalizedPath = normalizeRelativePath(rule.path || '');
      } catch {
        return null; // Invalid path
      }

      if (!normalizedPath) return null;

      // Validate permissions
      const permissions = ['rw', 'ro', 'hidden'].includes(rule.permissions)
        ? rule.permissions
        : 'rw';

      return {
        id: rule.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        path: normalizedPath,
        recursive: Boolean(rule.recursive),
        permissions,
        // Stored as a plain yes or no, so the page shows a definite box and
        // nothing downstream has to guess again. What a rule written before
        // this switch existed means is decided in one place, utils/accessRules.
        appliesToAdmins: ruleAppliesToAdmins({ ...rule, permissions }),
      };
    })
    .filter(Boolean);
};

/**
 * The access section: the rules, and whether they hold administrators.
 *
 * Kept together because the two are read together — a rule says whether it
 * holds administrators, and this setting holds them to all of them at once.
 */
const sanitizeAccess = (access = {}) => {
  const source = access && typeof access === 'object' && !Array.isArray(access) ? access : {};
  return {
    rules: sanitizeAccessRules(source.rules || []),
    applyToAdmins: source.applyToAdmins === true,
  };
};

/**
 * Sanitize branding settings
 */
const sanitizeBranding = (branding = {}) => {
  return {
    appName:
      typeof branding.appName === 'string' ? branding.appName.trim().slice(0, 100) : 'Explorer',
    appLogoUrl:
      typeof branding.appLogoUrl === 'string'
        ? branding.appLogoUrl.trim().slice(0, 500)
        : '/logo.svg',
    showPoweredBy: typeof branding.showPoweredBy === 'boolean' ? branding.showPoweredBy : false,
  };
};

/**
 * The trash settings in force: on or off, how many days an item is kept, and
 * how much of a volume the trash may hold — a share of it, capped by a size
 * when one is set. An explicit `maxBytes: null` removes the cap; a field left
 * out keeps the default the environment gave.
 */
const sanitizeTrash = (trash = {}) => {
  // eslint-disable-next-line global-require
  const { trash: defaults } = require('../config/index');
  // eslint-disable-next-line global-require
  const { parseByteSize } = require('../utils/env');
  const source = trash && typeof trash === 'object' ? trash : {};
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integerIn = (value, min, max, fallback) =>
    Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;
  const rawMaxBytes =
    typeof source.maxBytes === 'string' ? parseByteSize(source.maxBytes) : source.maxBytes;

  let maxBytes = defaults.maxBytes;
  if (source.maxBytes === null) maxBytes = null;
  else if (Number.isFinite(rawMaxBytes) && rawMaxBytes > 0) maxBytes = Math.floor(rawMaxBytes);

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    retentionDays: integerIn(source.retentionDays, 1, 3650, defaults.retentionDays),
    maxPercent: integerIn(source.maxPercent, 1, 90, defaults.maxPercent),
    maxBytes,
  };
};

/**
 * The file-version settings in force: whether a save keeps what it replaces,
 * and the retention thinning (everything for a while, then hourly, then daily),
 * a per-file cap and a session-checkpoint gap. Out-of-range values are clamped,
 * and the windows are kept consistent (hourly covers keep-all, daily covers
 * hourly), so the policy never contradicts itself.
 */
const sanitizeVersions = (versions = {}) => {
  // eslint-disable-next-line global-require
  const { versions: defaults, VERSION_BOUNDS } = require('../config/index');
  const source = versions && typeof versions === 'object' ? versions : {};
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integer = (key) => {
    const [min, max] = VERSION_BOUNDS[key];
    return Number.isFinite(source[key]) ? clamp(Math.round(source[key]), min, max) : defaults[key];
  };
  const keepAllHours = integer('keepAllHours');
  const hourlyDays = Math.max(integer('hourlyDays'), Math.ceil(keepAllHours / 24));
  const dailyDays = Math.max(integer('dailyDays'), hourlyDays);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    keepAllHours,
    hourlyDays,
    dailyDays,
    maxPerFile: integer('maxPerFile'),
    sessionCheckpointMinutes: integer('sessionCheckpointMinutes'),
  };
};

const FOLDER_SIZE_MODES = ['off', 'shallow', 'full'];

/**
 * What an administrator chose for the two background workers. Only a choice:
 * when the environment set the same thing, the environment is what runs, and
 * this is kept for the day the variable is taken away.
 */
const sanitizeFolderSize = (folderSize = {}) => ({
  excludedPaths: folderSizeExclusions.sanitizePaths(folderSize.excludedPaths || []),
  mode: FOLDER_SIZE_MODES.includes(folderSize.mode) ? folderSize.mode : 'off',
});

const sanitizeSearchIndex = (searchIndex = {}) => ({
  excludedPaths: searchIndexExclusions.sanitizePaths(searchIndex.excludedPaths || []),
  enabled: searchIndex.enabled === true,
});

/**
 * The activity log settings in force: on or off, and how long a line is kept.
 *
 * Off is the default and stays the default: a log nobody asked for is a record
 * of somebody's day that nobody reads.
 */
const sanitizeActivity = (activity = {}) => {
  // eslint-disable-next-line global-require
  const { activity: defaults } = require('../config/index');
  const source = activity && typeof activity === 'object' ? activity : {};
  const retentionDays = Number(source.retentionDays);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    retentionDays: Number.isFinite(retentionDays)
      ? Math.max(1, Math.min(3650, Math.round(retentionDays)))
      : defaults.retentionDays,
  };
};

/**
 * Get public settings (branding only, no auth required)
 */
const getPublicSettings = async () => {
  try {
    const db = await getDb();
    const brandingRow = db
      .prepare('SELECT value FROM system_settings WHERE category = ? AND key = ?')
      .get('branding', 'branding');

    if (brandingRow) {
      const branding = JSON.parse(brandingRow.value);
      return {
        branding: sanitizeBranding(branding),
      };
    }
  } catch (err) {
    // Fallback to JSON if DB read fails
  }

  // Fallback to JSON storage
  try {
    const data = await storage.get();
    const branding = data.settings?.branding || {};
    return {
      branding: sanitizeBranding(branding),
    };
  } catch (err) {
    // Return defaults if all else fails
    return {
      branding: sanitizeBranding({}),
    };
  }
};

/**
 * Get user-specific settings
 */
const MIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024;
const HARD_MAX_UPLOAD_CHUNK_SIZE_MIB = 512;
const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

// The administrator's ceiling (MAX_CHUNK_SIZE_MIB), itself capped: a chunk is
// held whole in memory at each end, so an unbounded one is a way to run a
// server out of it.
const resolveMaxChunkSizeBytes = () => {
  const raw = Number(env.MAX_CHUNK_SIZE_MIB);
  const mib =
    Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), HARD_MAX_UPLOAD_CHUNK_SIZE_MIB)
      : HARD_MAX_UPLOAD_CHUNK_SIZE_MIB;
  return Math.max(MIN_UPLOAD_CHUNK_SIZE_BYTES, mib * 1024 * 1024);
};
const MAX_UPLOAD_CHUNK_SIZE_BYTES = resolveMaxChunkSizeBytes();

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const defaultUploadSettings = () => {
  const configuredChunkSize = parseByteSize(env.UPLOAD_CHUNK_SIZE);
  const chunkSizeBytes =
    Number.isFinite(configuredChunkSize) && configuredChunkSize > 0
      ? configuredChunkSize
      : DEFAULT_UPLOAD_CHUNK_SIZE_BYTES;

  return {
    chunkedEnabled: env.UPLOAD_CHUNKED_ENABLED ?? false,
    chunkSizeBytes: clampNumber(
      Math.floor(chunkSizeBytes),
      MIN_UPLOAD_CHUNK_SIZE_BYTES,
      MAX_UPLOAD_CHUNK_SIZE_BYTES
    ),
  };
};

const sanitizeUploads = (uploads = {}) => {
  const defaults = defaultUploadSettings();
  const rawChunkSize =
    typeof uploads.chunkSizeBytes === 'string'
      ? parseByteSize(uploads.chunkSizeBytes)
      : uploads.chunkSizeBytes;

  return {
    chunkedEnabled:
      typeof uploads.chunkedEnabled === 'boolean'
        ? uploads.chunkedEnabled
        : defaults.chunkedEnabled,
    chunkSizeBytes: Number.isFinite(rawChunkSize)
      ? clampNumber(
          Math.floor(rawChunkSize),
          MIN_UPLOAD_CHUNK_SIZE_BYTES,
          MAX_UPLOAD_CHUNK_SIZE_BYTES
        )
      : defaults.chunkSizeBytes,
  };
};

const getUserSettings = async (userId) => {
  if (!userId) return {};

  try {
    const db = await getDb();
    const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);

    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return settings;
  } catch (err) {
    return {};
  }
};

/**
 * Get system settings (admin only)
 */
const getSystemSettings = async () => {
  try {
    const db = await getDb();
    const rows = db
      .prepare('SELECT key, value FROM system_settings WHERE category = ?')
      .all('system');

    const thumbnails = { enabled: true, size: 200, quality: 70, concurrency: 10 };
    const access = { rules: [] };
    let trash = {};
    let versions = {};
    let uploads = {};
    let activity = {};
    let folderSize = {};
    let searchIndex = {};

    for (const row of rows) {
      try {
        if (row.key === 'thumbnails') {
          Object.assign(thumbnails, JSON.parse(row.value));
        } else if (row.key === 'access') {
          Object.assign(access, JSON.parse(row.value));
        } else if (row.key === 'trash') {
          trash = JSON.parse(row.value);
        } else if (row.key === 'versions') {
          versions = JSON.parse(row.value);
        } else if (row.key === 'uploads') {
          uploads = JSON.parse(row.value);
        } else if (row.key === 'activity') {
          activity = JSON.parse(row.value);
        } else if (row.key === 'folderSize') {
          folderSize = JSON.parse(row.value);
        } else if (row.key === 'searchIndex') {
          searchIndex = JSON.parse(row.value);
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return {
      thumbnails: sanitizeThumbnails(thumbnails),
      access: sanitizeAccess(access),
      trash: sanitizeTrash(trash),
      versions: sanitizeVersions(versions),
      uploads: sanitizeUploads(uploads),
      activity: sanitizeActivity(activity),
      folderSize: {
        ...sanitizeFolderSize(folderSize),
        environmentExcludedPaths: folderSizeExclusions.snapshot().environmentExcludedPaths,
      },
      searchIndex: {
        ...sanitizeSearchIndex(searchIndex),
        environmentExcludedPaths: searchIndexExclusions.snapshot().environmentExcludedPaths,
      },
    };
  } catch (err) {
    // Fallback to JSON storage
    try {
      const data = await storage.get();
      const settings = data.settings || {};
      return {
        thumbnails: sanitizeThumbnails(settings.thumbnails),
        access: sanitizeAccess(settings.access),
        trash: sanitizeTrash(settings.trash),
        versions: sanitizeVersions(settings.versions),
        uploads: sanitizeUploads(settings.uploads),
        activity: sanitizeActivity(settings.activity),
        folderSize: sanitizeFolderSize(settings.folderSize),
        searchIndex: sanitizeSearchIndex(settings.searchIndex),
      };
    } catch (err2) {
      // Return defaults
      return {
        thumbnails: sanitizeThumbnails({}),
        access: sanitizeAccess({}),
        trash: sanitizeTrash({}),
        versions: sanitizeVersions({}),
        uploads: sanitizeUploads({}),
        activity: sanitizeActivity({}),
        folderSize: sanitizeFolderSize({}),
        searchIndex: sanitizeSearchIndex({}),
      };
    }
  }
};

/**
 * Get settings for a user based on their role
 * - Public: branding only
 * - Regular user: branding + user settings
 * - Admin: branding + user settings + system settings
 */
const getSettingsForUser = async (user) => {
  const publicSettings = await getPublicSettings();
  const result = {
    branding: publicSettings.branding,
  };

  if (user && user.id) {
    const userSettings = await getUserSettings(user.id);
    result.user = userSettings;

    const isAdmin = Array.isArray(user.roles) && user.roles.includes('admin');
    if (isAdmin) {
      const systemSettings = await getSystemSettings();
      result.thumbnails = systemSettings.thumbnails;
      result.access = systemSettings.access;
      result.trash = systemSettings.trash;
      result.versions = systemSettings.versions;
      result.uploads = systemSettings.uploads;
      result.activity = systemSettings.activity;
      result.folderSize = systemSettings.folderSize;
      result.searchIndex = systemSettings.searchIndex;
    }
  }

  return result;
};

/**
 * The preferences an account may set, in one place.
 *
 * There used to be two lists: this one, which decides how a value is
 * sanitised, and another inside the settings route, which decides whether the
 * key is written at all. Adding a preference to one and not the other produced
 * a toggle that moved on screen, answered success, and stored nothing — so the
 * two are the same list now, and the route asks here.
 */
const USER_BOOLEAN_SETTINGS = new Set([
  'showHiddenFiles',
  'showThumbnails',
  'showVersionMarks',
  'documentsOpenInNewTab',
  'showSidebarFavorites',
  'showSidebarShares',
  'showSidebarTools',
]);

/**
 * A language tag, or null for "follow the browser".
 *
 * Checked for shape rather than against the list of translations: the list
 * changes with a release, and a stored tag we no longer ship should fall back
 * on screen, not be refused on the way in.
 */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const asLocale = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const tag = value.trim();
  return LANGUAGE_TAG.test(tag) ? tag : undefined;
};

const USER_SETTING_KEYS = new Set([
  ...USER_BOOLEAN_SETTINGS,
  'defaultShareExpiration',
  'skipHome',
  'locale',
]);

/**
 * Set a user setting
 */
const setUserSetting = async (userId, key, value) => {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const db = await getDb();
  const now = new Date().toISOString();

  // Validate and sanitize value based on key
  let sanitizedValue = value;
  if (USER_BOOLEAN_SETTINGS.has(key)) {
    sanitizedValue = Boolean(value);
  } else if (key === 'locale') {
    const tag = asLocale(value);
    // `undefined` means "not a language tag": the stored value is left alone
    // rather than replaced by something the interface cannot read.
    if (tag === undefined) return (await getUserSettings(userId))[key];
    sanitizedValue = tag;
  } else if (key === 'defaultShareExpiration') {
    // Validate expiration object: { value: number, unit: 'days'|'weeks'|'months' } or null
    if (value === null || value === undefined) {
      sanitizedValue = null;
    } else if (typeof value === 'object' && value !== null) {
      const validUnits = ['days', 'weeks', 'months'];
      const unit = validUnits.includes(value.unit) ? value.unit : 'weeks';
      const numValue =
        Number.isFinite(value.value) && value.value > 0 ? Math.floor(value.value) : null;
      sanitizedValue = numValue ? { value: numValue, unit } : null;
    } else {
      sanitizedValue = null;
    }
  } else if (key === 'skipHome') {
    // Can be null (use env), true, or false
    if (value === null || value === undefined) {
      sanitizedValue = null;
    } else {
      sanitizedValue = Boolean(value);
    }
  }

  const valueJson = JSON.stringify(sanitizedValue);

  // Check if setting exists
  const existing = db
    .prepare('SELECT id FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, key);

  if (existing) {
    db.prepare(
      'UPDATE user_settings SET value = ?, updated_at = ? WHERE user_id = ? AND key = ?'
    ).run(valueJson, now, userId, key);
  } else {
    db.prepare(
      'INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(generateId(), userId, key, valueJson, now);
  }

  return sanitizedValue;
};

/**
 * Set a system setting (admin only)
 */
/**
 * Change the branding, and answer what it was and what it is now.
 *
 * Read and written without yielding in between — the database answers
 * synchronously — so two saves at once cannot both start from the same branding:
 * the logo a save replaced is the one it was the last to see, and removing it
 * cannot take away the logo another save has just put in place.
 *
 * @returns {Promise<{previous: object, current: object}>}
 */
const replaceBranding = async (update) => {
  const db = await getDb();
  const row = db
    .prepare('SELECT value FROM system_settings WHERE category = ? AND key = ?')
    .get('branding', 'branding');

  let stored = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      // An unreadable value is the default branding.
    }
  }

  const previous = sanitizeBranding(stored);
  const current = sanitizeBranding({ ...previous, ...update });

  const now = new Date().toISOString();
  const valueJson = JSON.stringify(current);
  const existing = db
    .prepare('SELECT id FROM system_settings WHERE category = ? AND key = ?')
    .get('branding', 'branding');
  if (existing) {
    db.prepare(
      'UPDATE system_settings SET value = ?, updated_at = ? WHERE category = ? AND key = ?'
    ).run(valueJson, now, 'branding', 'branding');
  } else {
    db.prepare(
      'INSERT INTO system_settings (id, category, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(generateId(), 'branding', 'branding', valueJson, now);
  }

  return { previous, current };
};

const setSystemSetting = async (category, key, value) => {
  if (category !== 'branding' && category !== 'system') {
    throw new Error('Invalid category. Must be "branding" or "system"');
  }

  const db = await getDb();
  const now = new Date().toISOString();

  // Sanitize based on key
  let sanitizedValue = value;
  if (key === 'thumbnails') {
    sanitizedValue = sanitizeThumbnails(value);
  } else if (key === 'access') {
    sanitizedValue = sanitizeAccess(value);
  } else if (key === 'branding') {
    sanitizedValue = sanitizeBranding(value);
  } else if (key === 'trash') {
    sanitizedValue = sanitizeTrash(value);
  } else if (key === 'versions') {
    sanitizedValue = sanitizeVersions(value);
  } else if (key === 'uploads') {
    sanitizedValue = sanitizeUploads(value);
  } else if (key === 'activity') {
    sanitizedValue = sanitizeActivity(value);
  } else if (key === 'folderSize') {
    sanitizedValue = sanitizeFolderSize(value);
  } else if (key === 'searchIndex') {
    // The search index had no case here, so what was stored for it was the
    // merge as it came: paths with spaces around them, empty entries, the same
    // folder twice. The worker was handed a sanitised copy and behaved, so only
    // the stored value was wrong — and it is the one the next merge starts from.
    sanitizedValue = sanitizeSearchIndex(value);
  }

  const valueJson = JSON.stringify(sanitizedValue);

  // Check if setting exists
  const existing = db
    .prepare('SELECT id FROM system_settings WHERE category = ? AND key = ?')
    .get(category, key);

  if (existing) {
    db.prepare(
      'UPDATE system_settings SET value = ?, updated_at = ? WHERE category = ? AND key = ?'
    ).run(valueJson, now, category, key);
  } else {
    db.prepare(
      'INSERT INTO system_settings (id, category, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(generateId(), category, key, valueJson, now);
  }

  return sanitizedValue;
};

/**
 * Legacy method: Get all settings (for backward compatibility)
 * Returns system settings + branding
 */
const getSettings = async () => {
  const systemSettings = await getSystemSettings();
  const publicSettings = await getPublicSettings();

  return {
    ...systemSettings,
    branding: publicSettings.branding,
  };
};

/**
 * Legacy method: Set settings (for backward compatibility)
 * Updates system settings and branding
 */
const setSettings = async (partial) => {
  const current = await getSettings();

  // Deep merge
  const merged = {
    thumbnails: { ...current.thumbnails, ...(partial.thumbnails || {}) },
    access: {
      rules: partial.access?.rules !== undefined ? partial.access.rules : current.access.rules,
      // Saved apart from the rules on the settings page, so each has to survive
      // the other being saved on its own.
      applyToAdmins:
        partial.access?.applyToAdmins !== undefined
          ? partial.access.applyToAdmins
          : current.access.applyToAdmins,
    },
    branding: { ...current.branding, ...(partial.branding || {}) },
  };

  // Save to DB
  if (partial.thumbnails) {
    merged.thumbnails = await setSystemSetting('system', 'thumbnails', merged.thumbnails);
  }
  if (partial.access) {
    merged.access = await setSystemSetting('system', 'access', merged.access);
  }
  if (partial.branding) {
    merged.branding = await setSystemSetting('branding', 'branding', merged.branding);
  }

  // Also update JSON for backward compatibility during transition
  try {
    await storage.update((data) => ({
      ...data,
      settings: {
        thumbnails: merged.thumbnails,
        access: merged.access,
        branding: merged.branding,
      },
    }));
  } catch (err) {
    // Non-fatal, continue
  }

  return merged;
};

/**
 * Update settings with an updater function
 */
const updateSettings = async (updater) => {
  const current = await getSettings();
  const next = typeof updater === 'function' ? updater(current) : current;
  return setSettings(next);
};

module.exports = {
  replaceBranding,
  USER_SETTING_KEYS,
  MAX_UPLOAD_CHUNK_SIZE_BYTES,
  getPublicSettings,
  sanitizeAccess,
  sanitizeTrash,
  sanitizeVersions,
  sanitizeActivity,
  sanitizeFolderSize,
  sanitizeSearchIndex,
  getUserSettings,
  getSystemSettings,
  getSettingsForUser,
  setUserSetting,
  setSystemSetting,
  // Legacy methods for backward compatibility
  getSettings,
  setSettings,
  updateSettings,
};
