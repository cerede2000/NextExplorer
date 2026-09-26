const { getDb } = require('./db');
const env = require('../config/env');
const { parseByteSize } = require('../utils/env');
const { normalizeRelativePath } = require('../utils/pathUtils');
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
      };
    })
    .filter(Boolean);
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

    for (const row of rows) {
      try {
        if (row.key === 'thumbnails') {
          Object.assign(thumbnails, JSON.parse(row.value));
        } else if (row.key === 'access') {
          const accessData = JSON.parse(row.value);
          if (accessData.rules) {
            access.rules = accessData.rules;
          }
        } else if (row.key === 'trash') {
          trash = JSON.parse(row.value);
        } else if (row.key === 'versions') {
          versions = JSON.parse(row.value);
        } else if (row.key === 'uploads') {
          uploads = JSON.parse(row.value);
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return {
      thumbnails: sanitizeThumbnails(thumbnails),
      access: {
        rules: sanitizeAccessRules(access.rules),
      },
      trash: sanitizeTrash(trash),
      versions: sanitizeVersions(versions),
      uploads: sanitizeUploads(uploads),
    };
  } catch (err) {
    // Fallback to JSON storage
    try {
      const data = await storage.get();
      const settings = data.settings || {};
      return {
        thumbnails: sanitizeThumbnails(settings.thumbnails),
        access: {
          rules: sanitizeAccessRules(settings.access?.rules || []),
        },
        trash: sanitizeTrash(settings.trash),
        versions: sanitizeVersions(settings.versions),
        uploads: sanitizeUploads(settings.uploads),
      };
    } catch (err2) {
      // Return defaults
      return {
        thumbnails: sanitizeThumbnails({}),
        access: { rules: [] },
        trash: sanitizeTrash({}),
        versions: sanitizeVersions({}),
        uploads: sanitizeUploads({}),
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
    sanitizedValue = {
      rules: sanitizeAccessRules(value.rules || []),
    };
  } else if (key === 'branding') {
    sanitizedValue = sanitizeBranding(value);
  } else if (key === 'trash') {
    sanitizedValue = sanitizeTrash(value);
  } else if (key === 'versions') {
    sanitizedValue = sanitizeVersions(value);
  } else if (key === 'uploads') {
    sanitizedValue = sanitizeUploads(value);
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
  USER_SETTING_KEYS,
  MAX_UPLOAD_CHUNK_SIZE_BYTES,
  getPublicSettings,
  sanitizeTrash,
  sanitizeVersions,
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
