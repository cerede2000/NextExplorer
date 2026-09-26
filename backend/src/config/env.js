const { normalizeBoolean } = require('../utils/env');

/**
 * Single source of truth for ALL environment variables.
 * Easy to see what env vars the app uses and their defaults.
 */
module.exports = {
  // Server
  ADDRESS: process.env.ADDRESS || '0.0.0.0',
  PORT: Number(process.env.PORT) || 3000,
  // Node.js HTTP server request timeout (ms). Set to 0 to disable.
  // Node defaults to 300000ms (5 minutes) on modern versions, which can abort large uploads.
  HTTP_TIMEOUT: process.env.HTTP_TIMEOUT != null ? Number(process.env.HTTP_TIMEOUT) : 0,

  // Paths
  VOLUME_ROOT: process.env.VOLUME_ROOT || '/mnt',
  CONFIG_DIR: process.env.CONFIG_DIR || '/config',
  CACHE_DIR: process.env.CACHE_DIR || '/cache',
  USER_ROOT: process.env.USER_ROOT || '',
  USER_FOLDER_NAME_ORDER: process.env.USER_FOLDER_NAME_ORDER?.trim() || null,
  HIDDEN_FILE_PATTERNS: process.env.HIDDEN_FILE_PATTERNS,

  // Public URL & Network
  PUBLIC_URL: process.env.PUBLIC_URL?.trim() || null,
  // Additional origin(s) the app can legitimately be reached from (e.g. a LAN IP
  // used for fast local uploads). Comma-separated. These are treated as valid
  // (no public-URL mismatch warning) and accepted by CORS, while PUBLIC_URL stays
  // the canonical URL used to build share links, OIDC callbacks, etc.
  INTERNAL_URL: process.env.INTERNAL_URL?.trim() || null,
  TRUST_PROXY: process.env.TRUST_PROXY?.trim().toLowerCase(),

  // CORS
  CORS_ORIGINS:
    process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || '',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL?.trim().toLowerCase() || null,
  DEBUG: normalizeBoolean(process.env.DEBUG),
  ENABLE_HTTP_LOGGING: normalizeBoolean(process.env.ENABLE_HTTP_LOGGING) || false,

  // Auth
  AUTH_ENABLED: normalizeBoolean(process.env.AUTH_ENABLED),
  AUTH_MODE: process.env.AUTH_MODE?.trim().toLowerCase() || null,
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || null,
  SESSION_MAX_AGE_DAYS: Number(process.env.SESSION_MAX_AGE_DAYS) || 30,
  AUTH_MAX_FAILED: Number(process.env.AUTH_MAX_FAILED) || 5,
  AUTH_LOCK_MINUTES: Number(process.env.AUTH_LOCK_MINUTES) || 15,
  AUTH_ADMIN_EMAIL: process.env.AUTH_ADMIN_EMAIL?.trim() || process.env.ADMIN_EMAIL?.trim() || null,
  AUTH_ADMIN_PASSWORD: process.env.AUTH_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || null,

  // OIDC
  OIDC_ENABLED: normalizeBoolean(process.env.OIDC_ENABLED),
  OIDC_ISSUER: process.env.OIDC_ISSUER || process.env.OIDC_ISSUER_URL || null,
  OIDC_AUTHORIZATION_URL: process.env.OIDC_AUTHORIZATION_URL || null,
  OIDC_TOKEN_URL: process.env.OIDC_TOKEN_URL || null,
  OIDC_USERINFO_URL: process.env.OIDC_USERINFO_URL || null,
  OIDC_LOGOUT_URL: process.env.OIDC_LOGOUT_URL || null,
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID || null,
  OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET || null,
  OIDC_CALLBACK_URL: process.env.OIDC_CALLBACK_URL || process.env.OIDC_REDIRECT_URI || null,
  // Allowlisted native app redirect URIs for the mobile OIDC bridge (iOS/Android).
  OIDC_MOBILE_REDIRECT_URIS: process.env.OIDC_MOBILE_REDIRECT_URIS || null,
  OIDC_SCOPES: process.env.OIDC_SCOPES || process.env.OIDC_SCOPE || null,
  OIDC_ADMIN_GROUPS: process.env.OIDC_ADMIN_GROUPS || process.env.OIDC_ADMIN_GROUP || null,
  OIDC_REQUIRE_EMAIL_VERIFIED: normalizeBoolean(process.env.OIDC_REQUIRE_EMAIL_VERIFIED) || false,
  // When false, OIDC login is only allowed for users that already exist in the DB (local or OIDC-linked).
  OIDC_AUTO_CREATE_USERS: normalizeBoolean(process.env.OIDC_AUTO_CREATE_USERS) ?? true,

  // Search
  SEARCH_DEEP: normalizeBoolean(process.env.SEARCH_DEEP),
  SEARCH_RIPGREP: normalizeBoolean(process.env.SEARCH_RIPGREP),
  // --- Archive extraction ---
  MAX_EXTRACTED_ARCHIVE_SIZE: process.env.MAX_EXTRACTED_ARCHIVE_SIZE?.trim() || null,
  MAX_ARCHIVE_ENTRIES: Number(process.env.MAX_ARCHIVE_ENTRIES) || 100000,
  ARCHIVE_EXTENSIONS: process.env.ARCHIVE_EXTENSIONS || '',
  // --- Folder size index ---
  FOLDER_SIZE_MODE: process.env.FOLDER_SIZE_MODE?.trim().toLowerCase() || 'off',
  FOLDER_SIZE_EXCLUDE_PATHS: process.env.FOLDER_SIZE_EXCLUDE_PATHS || '',
  FOLDER_SIZE_CONCURRENCY: Number(process.env.FOLDER_SIZE_CONCURRENCY) || 6,
  FOLDER_SIZE_NETWORK_CONCURRENCY: Number(process.env.FOLDER_SIZE_NETWORK_CONCURRENCY) || 2,
  FOLDER_SIZE_FLUSH_MS: Number(process.env.FOLDER_SIZE_FLUSH_MS) || 3000,
  FOLDER_SIZE_RECONCILE_MS: Number(process.env.FOLDER_SIZE_RECONCILE_MS) || 0,
  FOLDER_SIZE_RECONCILE_MIN_MS: Number(process.env.FOLDER_SIZE_RECONCILE_MIN_MS) || 900000,
  FOLDER_SIZE_RECONCILE_MAX_MS: Number(process.env.FOLDER_SIZE_RECONCILE_MAX_MS) || 43200000,
  FOLDER_SIZE_RECONCILE_BATCH: Number(process.env.FOLDER_SIZE_RECONCILE_BATCH) || 100,
  FOLDER_SIZE_REBUILD: normalizeBoolean(process.env.FOLDER_SIZE_REBUILD) || false,
  // --- Search index ---
  SEARCH_INDEX: normalizeBoolean(process.env.SEARCH_INDEX) ?? false,
  SEARCH_INDEX_BATCH: Number(process.env.SEARCH_INDEX_BATCH) || null,
  SEARCH_INDEX_CPU_PERCENT: Number(process.env.SEARCH_INDEX_CPU_PERCENT) || null,
  SEARCH_INDEX_MEMORY_MB: Number(process.env.SEARCH_INDEX_MEMORY_MB) || null,
  SEARCH_INDEX_EXCLUDE: process.env.SEARCH_INDEX_EXCLUDE?.trim() || null,
  SEARCH_INDEX_REBUILD: normalizeBoolean(process.env.SEARCH_INDEX_REBUILD) ?? false,
  SEARCH_INDEX_RECONCILE_MS: Number(process.env.SEARCH_INDEX_RECONCILE_MS) || null,
  SEARCH_TIMEOUT_MS: Number(process.env.SEARCH_TIMEOUT_MS) || null,
  SEARCH_MAX_FILESIZE: process.env.SEARCH_MAX_FILESIZE?.trim() || null,

  // OnlyOffice
  ONLYOFFICE_URL: process.env.ONLYOFFICE_URL?.trim() || null,
  ONLYOFFICE_SECRET: process.env.ONLYOFFICE_SECRET || null,
  ONLYOFFICE_LANG: process.env.ONLYOFFICE_LANG?.trim() || 'en',
  ONLYOFFICE_FORCE_SAVE: normalizeBoolean(process.env.ONLYOFFICE_FORCE_SAVE) || false,
  ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS: Number(process.env.ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS) || 10000,
  // 0 disables proactive writes to the external storage. A bounded interval
  // keeps the Document Server's internal autosave from becoming a full document
  // conversion on every edit.
  ONLYOFFICE_AUTO_SAVE_INTERVAL_MS: (() => {
    const value = Number(process.env.ONLYOFFICE_AUTO_SAVE_INTERVAL_MS);
    return Number.isFinite(value) && value >= 0 ? value : 30000;
  })(),
  ONLYOFFICE_FILE_EXTENSIONS: process.env.ONLYOFFICE_FILE_EXTENSIONS || '',
  ONLYOFFICE_DOWNLOAD_ORIGINS: process.env.ONLYOFFICE_DOWNLOAD_ORIGINS || '',

  // Collabora (WOPI)
  COLLABORA_URL: process.env.COLLABORA_URL?.trim() || null,
  COLLABORA_DISCOVERY_URL: process.env.COLLABORA_DISCOVERY_URL?.trim() || null,
  COLLABORA_SECRET: process.env.COLLABORA_SECRET || null,
  COLLABORA_LANG: process.env.COLLABORA_LANG?.trim() || 'en',
  COLLABORA_FILE_EXTENSIONS: process.env.COLLABORA_FILE_EXTENSIONS || '',

  // Features
  SHOW_VOLUME_USAGE: normalizeBoolean(process.env.SHOW_VOLUME_USAGE) || false,

  // Trash: a deletion is a rename into a reserved space at the root of each
  // volume. These are the defaults; an administrator changes them in Settings.
  TRASH_ENABLED: normalizeBoolean(process.env.TRASH_ENABLED) ?? true,
  TRASH_RETENTION_DAYS: process.env.TRASH_RETENTION_DAYS?.trim() || '30',
  TRASH_MAX_PERCENT: process.env.TRASH_MAX_PERCENT?.trim() || '10',
  TRASH_MAX_SIZE: process.env.TRASH_MAX_SIZE?.trim() || null,

  // File versions: the content a save replaces is kept in the same reserved
  // space as the trash, within the same budget. Defaults again; an
  // administrator changes them in Settings.
  VERSIONS_ENABLED: normalizeBoolean(process.env.VERSIONS_ENABLED) ?? true,
  VERSIONS_KEEP_ALL_HOURS: process.env.VERSIONS_KEEP_ALL_HOURS?.trim() || '24',
  VERSIONS_HOURLY_DAYS: process.env.VERSIONS_HOURLY_DAYS?.trim() || '7',
  VERSIONS_DAILY_DAYS: process.env.VERSIONS_DAILY_DAYS?.trim() || '30',
  VERSIONS_MAX_PER_FILE: process.env.VERSIONS_MAX_PER_FILE?.trim() || '50',
  VERSIONS_SESSION_CHECKPOINT_MINUTES:
    process.env.VERSIONS_SESSION_CHECKPOINT_MINUTES?.trim() || '10',
  USER_DIR_ENABLED: normalizeBoolean(process.env.USER_DIR_ENABLED) || false,
  USER_VOLUMES: normalizeBoolean(process.env.USER_VOLUMES) || false,
  SKIP_HOME: normalizeBoolean(process.env.SKIP_HOME) || false,
  TERMINAL_ENABLED: normalizeBoolean(process.env.TERMINAL_ENABLED) ?? true,
  TERMINAL_FILE_EXTENSIONS: process.env.TERMINAL_FILE_EXTENSIONS || 'sh',

  // Uploads (direct, non-chunked)
  MAX_DIRECT_UPLOAD_SIZE: process.env.MAX_DIRECT_UPLOAD_SIZE?.trim() || null,
  UPLOAD_STORAGE_RESERVE: process.env.UPLOAD_STORAGE_RESERVE?.trim() || '64M',
  UPLOAD_CHUNK_SIZE: process.env.UPLOAD_CHUNK_SIZE,
  UPLOAD_CHUNKED_ENABLED: normalizeBoolean(process.env.UPLOAD_CHUNKED_ENABLED),
  MAX_CHUNK_SIZE_MIB: process.env.MAX_CHUNK_SIZE_MIB,
  UPLOAD_INACTIVITY_TIMEOUT: process.env.UPLOAD_INACTIVITY_TIMEOUT,
  THUMBNAILS_ENABLED: normalizeBoolean(process.env.THUMBNAILS_ENABLED) ?? true,
  THUMBNAIL_CACHE_MAX_FILES:
    process.env.THUMBNAIL_CACHE_MAX_FILES != null
      ? Number(process.env.THUMBNAIL_CACHE_MAX_FILES)
      : 3000,
  THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS:
    process.env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS != null
      ? Number(process.env.THUMBNAIL_CACHE_CLEANUP_INTERVAL_MS)
      : 60 * 60 * 1000,
  THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE:
    process.env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE != null
      ? Number(process.env.THUMBNAIL_CACHE_CLEANUP_BATCH_SIZE)
      : 500,
  THUMBNAIL_CACHE_TTL_DAYS:
    process.env.THUMBNAIL_CACHE_TTL_DAYS != null
      ? Number(process.env.THUMBNAIL_CACHE_TTL_DAYS)
      : 30,
  // ExifTool from the machine rather than the one in the archive: 23 MB of
  // Perl somebody who already has it would rather not carry twice (#9).
  // Empty means the bundled copy, which is the default and needs nothing.
  EXIFTOOL_PATH: process.env.EXIFTOOL_PATH || '',
  // Embedded RAW previews are full-size JPEGs, far larger than a thumbnail, and
  // a new one is extracted whenever a RAW file changes.
  RAW_PREVIEW_CACHE_MAX_FILES:
    process.env.RAW_PREVIEW_CACHE_MAX_FILES != null
      ? Number(process.env.RAW_PREVIEW_CACHE_MAX_FILES)
      : 500,
  THUMBNAIL_SHARP_CACHE_MEMORY_MB:
    process.env.THUMBNAIL_SHARP_CACHE_MEMORY_MB != null
      ? Number(process.env.THUMBNAIL_SHARP_CACHE_MEMORY_MB)
      : 0,
  THUMBNAIL_VIDEO_CONCURRENCY:
    process.env.THUMBNAIL_VIDEO_CONCURRENCY != null
      ? Number(process.env.THUMBNAIL_VIDEO_CONCURRENCY)
      : 3,
  THUMBNAIL_VIDEO_SEEK_SECONDS:
    process.env.THUMBNAIL_VIDEO_SEEK_SECONDS != null
      ? Number(process.env.THUMBNAIL_VIDEO_SEEK_SECONDS)
      : 5,
  THUMBNAIL_VIDEO_SEEK_PERCENT:
    process.env.THUMBNAIL_VIDEO_SEEK_PERCENT != null &&
    process.env.THUMBNAIL_VIDEO_SEEK_PERCENT.trim() !== ''
      ? Number(process.env.THUMBNAIL_VIDEO_SEEK_PERCENT)
      : null,
  THUMBNAIL_VIDEO_THREADS:
    process.env.THUMBNAIL_VIDEO_THREADS != null ? Number(process.env.THUMBNAIL_VIDEO_THREADS) : 2,
  THUMBNAIL_VIDEO_SCALE_FLAGS: process.env.THUMBNAIL_VIDEO_SCALE_FLAGS?.trim() || 'fast_bilinear',
  THUMBNAIL_BACKGROUND_QUEUE_LIMIT:
    process.env.THUMBNAIL_BACKGROUND_QUEUE_LIMIT != null
      ? Number(process.env.THUMBNAIL_BACKGROUND_QUEUE_LIMIT)
      : 16,
  THUMBNAIL_DIAGNOSTICS_ENABLED:
    normalizeBoolean(process.env.THUMBNAIL_DIAGNOSTICS_ENABLED) ?? false,
  THUMBNAIL_DIAGNOSTICS_INTERVAL_MS:
    process.env.THUMBNAIL_DIAGNOSTICS_INTERVAL_MS != null
      ? Number(process.env.THUMBNAIL_DIAGNOSTICS_INTERVAL_MS)
      : 30000,
  THUMBNAIL_SLOW_JOB_MS:
    process.env.THUMBNAIL_SLOW_JOB_MS != null ? Number(process.env.THUMBNAIL_SLOW_JOB_MS) : 10000,
  // How long one ffmpeg may take over a single thumbnail before it is killed.
  // Not a deadline anything waits on — the queue has given up long before —
  // but the only thing that ends a process that has stopped making progress.
  THUMBNAIL_FFMPEG_TIMEOUT_MS:
    process.env.THUMBNAIL_FFMPEG_TIMEOUT_MS != null
      ? Number(process.env.THUMBNAIL_FFMPEG_TIMEOUT_MS)
      : 5 * 60 * 1000,
  // Niceness applied to child ffmpeg/convert processes (0 = disabled, 1-19 lowers
  // their CPU priority so the Node event loop stays responsive during generation).
  THUMBNAIL_PROCESS_NICE:
    process.env.THUMBNAIL_PROCESS_NICE != null ? Number(process.env.THUMBNAIL_PROCESS_NICE) : 10,
  TUS_UPLOAD_DIR: process.env.TUS_UPLOAD_DIR?.trim() || null,
  TUS_INCOMPLETE_UPLOAD_TTL_MS: process.env.TUS_INCOMPLETE_UPLOAD_TTL_MS,
  TUS_CLEANUP_INTERVAL_MS: process.env.TUS_CLEANUP_INTERVAL_MS,
  MAX_FILES_PER_UPLOAD: Number(process.env.MAX_FILES_PER_UPLOAD) || 50,

  // Editor
  EDITOR_EXTENSIONS: process.env.EDITOR_EXTENSIONS || '',
  EDITOR_MAX_FILESIZE: process.env.EDITOR_MAX_FILESIZE?.trim() || null,

  // FFmpeg
  FFMPEG_PATH: process.env.FFMPEG_PATH || null,
  FFPROBE_PATH: process.env.FFPROBE_PATH || null,
  FFMPEG_HWACCEL: process.env.FFMPEG_HWACCEL?.trim() || null,
  FFMPEG_HWACCEL_DEVICE: process.env.FFMPEG_HWACCEL_DEVICE?.trim() || null,
  FFMPEG_HWACCEL_OUTPUT_FORMAT: process.env.FFMPEG_HWACCEL_OUTPUT_FORMAT?.trim() || null,

  // Favorites
  FAVORITES_DEFAULT_ICON: process.env.FAVORITES_DEFAULT_ICON || 'outline:StarIcon',

  // Shares
  SHARES_ENABLED: normalizeBoolean(process.env.SHARES_ENABLED) ?? true,
  SHARES_TOKEN_LENGTH: Number(process.env.SHARES_TOKEN_LENGTH) || 10,
  SHARES_MAX_PER_USER: Number(process.env.SHARES_MAX_PER_USER) || 100,
  SHARES_DEFAULT_EXPIRY_DAYS: Number(process.env.SHARES_DEFAULT_EXPIRY_DAYS) || 30,
  SHARES_GUEST_SESSION_HOURS: Number(process.env.SHARES_GUEST_SESSION_HOURS) || 24,
  SHARES_ALLOW_PASSWORD: normalizeBoolean(process.env.SHARES_ALLOW_PASSWORD) ?? true,
  SHARES_ALLOW_ANONYMOUS: normalizeBoolean(process.env.SHARES_ALLOW_ANONYMOUS) ?? true,
};
