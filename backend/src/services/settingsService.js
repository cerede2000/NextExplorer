const { getDb, prepared } = require('./db');
const { cachedForRequest } = require('../utils/requestContext');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { parseByteSize } = require('../utils/env');
const env = require('../config/env');
const storage = require('./storage/jsonStorage'); // Keep for backward compatibility fallback
const folderSizeExclusions = require('./folderSizeExclusions');
const { generateId } = require('../utils/ids');

const MIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024;
const HARD_MAX_UPLOAD_CHUNK_SIZE_MIB = 512;
const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

// Per-folder preferences are kept per user, and bounded: one entry per folder
// ever visited would otherwise grow without limit.
const MAX_FOLDER_PREFERENCES = 100;
const MAX_FOLDER_PATH_LENGTH = 1024;
const MAX_SORT_FIELD_LENGTH = 128;

// Admin-configurable upper bound (env MAX_CHUNK_SIZE_MIB), capped at the hard
// ceiling. Used to clamp both the default and any saved chunk size.
const resolveMaxChunkSizeBytes = () => {
  const raw = Number(env.MAX_CHUNK_SIZE_MIB);
  const mib =
    Number.isFinite(raw) && raw >= 1
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

  const chunkedAutoFallback = env.UPLOAD_CHUNKED_AUTO_FALLBACK ?? false;
  return {
    // Auto-fallback and forced chunked uploads are mutually exclusive — auto is a
    // direct-with-fallback mode, so it turns forced chunking off.
    chunkedEnabled: chunkedAutoFallback ? false : (env.UPLOAD_CHUNKED_ENABLED ?? false),
    chunkedAutoFallback,
    chunkSizeBytes: clampNumber(
      Math.floor(chunkSizeBytes),
      MIN_UPLOAD_CHUNK_SIZE_BYTES,
      MAX_UPLOAD_CHUNK_SIZE_BYTES
    ),
  };
};


const isValidFolderPath = (folderPath) =>
  typeof folderPath === 'string' &&
  folderPath.length > 0 &&
  folderPath.length <= MAX_FOLDER_PATH_LENGTH;

const sanitizeFolderSort = (sort) => {
  if (
    !sort ||
    typeof sort !== 'object' ||
    typeof sort.by !== 'string' ||
    sort.by.trim().length === 0 ||
    sort.by.length > MAX_SORT_FIELD_LENGTH ||
    (sort.order !== 'asc' && sort.order !== 'desc')
  ) {
    return null;
  }

  return {
    by: sort.by.trim(),
    order: sort.order,
    updatedAt: Number.isFinite(sort.updatedAt) ? Math.floor(sort.updatedAt) : 0,
  };
};

const sanitizeFolderSorts = (folderSorts) => {
  if (!folderSorts || typeof folderSorts !== 'object' || Array.isArray(folderSorts)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(folderSorts)
      .map(([folderPath, sort]) => {
        const sanitizedSort = sanitizeFolderSort(sort);
        return isValidFolderPath(folderPath) && sanitizedSort ? [folderPath, sanitizedSort] : null;
      })
      .filter(Boolean)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_FOLDER_PREFERENCES)
  );
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

const sanitizeFolderSize = (folderSize = {}) => ({
  excludedPaths: folderSizeExclusions.sanitizePaths(folderSize.excludedPaths || []),
});

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
 * Sanitize upload settings
 */
const sanitizeUploads = (uploads = {}) => {
  const defaults = defaultUploadSettings();
  const rawChunkSize =
    typeof uploads.chunkSizeBytes === 'string'
      ? parseByteSize(uploads.chunkSizeBytes)
      : uploads.chunkSizeBytes;

  const chunkedAutoFallback =
    typeof uploads.chunkedAutoFallback === 'boolean'
      ? uploads.chunkedAutoFallback
      : defaults.chunkedAutoFallback;
  const chunkedEnabled = chunkedAutoFallback
    ? false // mutually exclusive with auto-fallback (auto wins)
    : typeof uploads.chunkedEnabled === 'boolean'
      ? uploads.chunkedEnabled
      : defaults.chunkedEnabled;

  return {
    chunkedEnabled,
    chunkedAutoFallback,
    chunkSizeBytes: Number.isFinite(rawChunkSize)
      ? clampNumber(
          Math.floor(rawChunkSize),
          MIN_UPLOAD_CHUNK_SIZE_BYTES,
          MAX_UPLOAD_CHUNK_SIZE_BYTES
        )
      : defaults.chunkSizeBytes,
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
const getUserSettings = async (userId) => {
  if (!userId) return {};

  try {
    const db = await getDb();
    const rows = prepared(db, 'SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);

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

// Through `prepared` rather than db.prepare: these run on every preference
// change, and recompiling the same three statements each time is waste the
// rest of this file already avoids.
const upsertUserSetting = (db, userId, key, value) => {
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(value);
  const existing = prepared(db, 'SELECT id FROM user_settings WHERE user_id = ? AND key = ?').get(
    userId,
    key
  );

  if (existing) {
    prepared(
      db,
      'UPDATE user_settings SET value = ?, updated_at = ? WHERE user_id = ? AND key = ?'
    ).run(valueJson, now, userId, key);
  } else {
    prepared(
      db,
      'INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(generateId(), userId, key, valueJson, now);
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
    let uploads = defaultUploadSettings();
    const folderSize = { excludedPaths: [] };

    for (const row of rows) {
      try {
        if (row.key === 'thumbnails') {
          Object.assign(thumbnails, JSON.parse(row.value));
        } else if (row.key === 'access') {
          const accessData = JSON.parse(row.value);
          if (accessData.rules) {
            access.rules = accessData.rules;
          }
        } else if (row.key === 'uploads') {
          uploads = { ...uploads, ...JSON.parse(row.value) };
        } else if (row.key === 'folderSize') {
          Object.assign(folderSize, JSON.parse(row.value));
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
      uploads: sanitizeUploads(uploads),
      folderSize: {
        ...sanitizeFolderSize(folderSize),
        environmentExcludedPaths: folderSizeExclusions.snapshot().environmentExcludedPaths,
      },
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
        uploads: sanitizeUploads(settings.uploads),
        folderSize: {
          ...sanitizeFolderSize(settings.folderSize),
          environmentExcludedPaths: folderSizeExclusions.snapshot().environmentExcludedPaths,
        },
      };
    } catch (err2) {
      // Return defaults
      return {
        thumbnails: sanitizeThumbnails({}),
        access: { rules: [] },
        uploads: sanitizeUploads({}),
        folderSize: {
          excludedPaths: [],
          environmentExcludedPaths: folderSizeExclusions.snapshot().environmentExcludedPaths,
        },
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
    const systemSettings = await getSystemSettings();
    result.uploads = systemSettings.uploads;

    const isAdmin = Array.isArray(user.roles) && user.roles.includes('admin');
    if (isAdmin) {
      result.thumbnails = systemSettings.thumbnails;
      result.access = systemSettings.access;
      result.folderSize = systemSettings.folderSize;
    }
  }

  return result;
};

/**
 * Set a user setting
 */
const setUserSetting = async (userId, key, value) => {
  if (!userId) {
    throw new Error('User ID is required');
  }
  const db = await getDb();

  // Validate and sanitize value based on key
  let sanitizedValue = value;
  if (
    key === 'showHiddenFiles' ||
    key === 'showThumbnails' ||
    key === 'showSidebarFavorites' ||
    key === 'showSidebarShares' ||
    key === 'showSidebarTools'
  ) {
    sanitizedValue = Boolean(value);
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
  } else if (key === 'folderSorts') {
    sanitizedValue = sanitizeFolderSorts(value);
  }

  upsertUserSetting(db, userId, key, sanitizedValue);

  return sanitizedValue;
};

const setUserFolderSort = async (userId, folderPath, sort) => {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const sanitizedSort = sanitizeFolderSort(sort);
  if (!isValidFolderPath(folderPath) || !sanitizedSort) {
    return null;
  }

  const db = await getDb();
  const existing = prepared(
    db,
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?'
  ).get(userId, 'folderSorts');
  let existingFolderSorts = {};

  if (existing) {
    try {
      existingFolderSorts = JSON.parse(existing.value);
    } catch {
      existingFolderSorts = {};
    }
  }
  existingFolderSorts = sanitizeFolderSorts(existingFolderSorts);

  const folderSorts = sanitizeFolderSorts({
    ...existingFolderSorts,
    [folderPath]: {
      ...sanitizedSort,
      updatedAt: Date.now(),
    },
  });
  upsertUserSetting(db, userId, 'folderSorts', folderSorts);

  return folderSorts;
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
  } else if (key === 'uploads') {
    sanitizedValue = sanitizeUploads(value);
  } else if (key === 'branding') {
    sanitizedValue = sanitizeBranding(value);
  } else if (key === 'folderSize') {
    sanitizedValue = sanitizeFolderSize(value);
  }

  const valueJson = JSON.stringify(sanitizedValue);

  // Check if setting exists
  const existing = db
    .prepare('SELECT id FROM system_settings WHERE category = ? AND key = ?')
    .get(category, key);

  if (existing) {
    prepared(db, 
      'UPDATE system_settings SET value = ?, updated_at = ? WHERE category = ? AND key = ?'
    ).run(valueJson, now, category, key);
  } else {
    prepared(db, 
      'INSERT INTO system_settings (id, category, key, value, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(generateId(), category, key, valueJson, now);
  }

  return sanitizedValue;
};

/**
 * Legacy method: Get all settings (for backward compatibility)
 * Returns system settings + branding
 */
/**
 * Settings, read once per request.
 *
 * The access rules are consulted for every path, so a bulk operation asked for
 * these thousands of times over — each one several queries and a JSON parse,
 * to re-read values that cannot change while a single request is running. The
 * promise is memoized, not the value, so concurrent callers share one read.
 */
const getSettings = async () =>
  cachedForRequest('settings', 'all', async () => {
    const systemSettings = await getSystemSettings();
    const publicSettings = await getPublicSettings();

    return {
      ...systemSettings,
      branding: publicSettings.branding,
    };
  });

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
    uploads: { ...current.uploads, ...(partial.uploads || {}) },
    folderSize: {
      excludedPaths:
        partial.folderSize?.excludedPaths !== undefined
          ? partial.folderSize.excludedPaths
          : current.folderSize.excludedPaths,
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
  if (partial.folderSize) {
    merged.folderSize = await setSystemSetting('system', 'folderSize', merged.folderSize);
  }
  if (partial.branding) {
    merged.branding = await setSystemSetting('branding', 'branding', merged.branding);
  }
  if (partial.uploads) {
    merged.uploads = await setSystemSetting('system', 'uploads', merged.uploads);
  }

  // Also update JSON for backward compatibility during transition
  try {
    await storage.update((data) => ({
      ...data,
      settings: {
        thumbnails: merged.thumbnails,
        access: merged.access,
        uploads: merged.uploads,
        folderSize: merged.folderSize,
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
  getPublicSettings,
  getUserSettings,
  getSystemSettings,
  getSettingsForUser,
  setUserSetting,
  setUserFolderSort,
  setSystemSetting,
  sanitizeUploads,
  MAX_UPLOAD_CHUNK_SIZE_BYTES,
  // Legacy methods for backward compatibility
  getSettings,
  setSettings,
  updateSettings,
};
