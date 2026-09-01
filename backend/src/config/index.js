const path = require('path');
const crypto = require('crypto');
const env = require('./env');
const constants = require('./constants');
const loggingConfig = require('./logging');
const { parseByteSize } = require('../utils/env');
// logger reads config/logging, never this file — requiring it here makes no cycle.
const logger = require('../utils/logger');

const parseCommaOrSpaceList = (raw) => {
  if (!raw) return [];
  const parts = String(raw).includes(',') ? String(raw).split(',') : String(raw).split(/\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
};

// Keep the artifacts of a transfer in progress under the same configurable
// policy as other hidden files: `.download` while one is being fetched,
// `.uploading` while one is being written.
const DEFAULT_HIDDEN_FILE_PATTERNS = ['.', 'regex:\\.download$', 'regex:\\.uploading$'];

const parseRegexPattern = (token) => {
  if (token.startsWith('regex:')) {
    return { source: token.slice('regex:'.length), flags: '' };
  }

  if (token.startsWith('/')) {
    const lastSlash = token.lastIndexOf('/');
    if (lastSlash > 0) {
      return {
        source: token.slice(1, lastSlash),
        flags: token.slice(lastSlash + 1),
      };
    }
  }

  return null;
};

const escapeRipgrepGlob = (value) => String(value).replace(/[\\*?[\]{}]/g, '\\$&');

const parseHiddenFilePatterns = (raw) => {
  const tokens = raw == null ? DEFAULT_HIDDEN_FILE_PATTERNS : parseCommaOrSpaceList(raw);
  const prefixes = [];
  const regexes = [];

  for (const token of tokens) {
    const regexPattern = parseRegexPattern(token);
    if (!regexPattern) {
      prefixes.push(token);
      continue;
    }

    try {
      regexes.push(new RegExp(regexPattern.source, regexPattern.flags));
    } catch (err) {
      console.warn(`[Config] Invalid hidden file regex "${token}": ${err.message}`);
    }
  }

  const isHiddenName = (name) => {
    if (!name) return false;
    const baseName = String(name);
    if (prefixes.some((prefix) => prefix && baseName.startsWith(prefix))) return true;

    return regexes.some((regex) => {
      regex.lastIndex = 0;
      return regex.test(baseName);
    });
  };

  const isHiddenPath = (value) =>
    String(value || '')
      .split(/[\\/]+/)
      .filter(Boolean)
      .some(isHiddenName);

  return {
    patterns: tokens,
    prefixes,
    regexes,
    isHiddenName,
    isHiddenPath,
    ripgrepGlobExcludes: prefixes
      .filter((prefix) => prefix && !/[\\/]/.test(prefix))
      .map((prefix) => `!${escapeRipgrepGlob(prefix)}*`),
  };
};

const parseExtensionList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s.startsWith('.') ? s.slice(1) : s))
    .filter(Boolean);

// Helper: Parse comma/space-separated scopes
const parseScopes = (raw) => {
  const list = parseCommaOrSpaceList(raw);
  return list.length ? list : null;
};

// --- Personal folder naming ---
const DEFAULT_USER_FOLDER_NAME_ORDER = ['id', 'username', 'email_local'];
const VALID_USER_FOLDER_NAME_TOKENS = new Set([
  'id',
  'username',
  'email',
  'email_local',
  'displayname',
]);

const parseUserFolderNameOrder = (raw) => {
  const requested = parseCommaOrSpaceList(raw).map((token) => token.toLowerCase());
  const order = [];

  for (const token of requested) {
    if (!VALID_USER_FOLDER_NAME_TOKENS.has(token)) continue;
    if (!order.includes(token)) order.push(token);
  }

  return order.length ? order : DEFAULT_USER_FOLDER_NAME_ORDER;
};

// --- Paths ---
const volumeDir = path.resolve(env.VOLUME_ROOT);
const configDir = path.resolve(env.CONFIG_DIR);
const cacheDir = path.resolve(env.CACHE_DIR);
const userRootDir = env.USER_ROOT ? path.resolve(env.USER_ROOT) : path.join(volumeDir, '_users');

const directories = {
  volume: volumeDir,
  volumeWithSep: volumeDir.endsWith(path.sep) ? volumeDir : `${volumeDir}${path.sep}`,
  config: configDir,
  cache: cacheDir,
  thumbnails: path.join(cacheDir, 'thumbnails'),
  extensions: path.join(configDir, 'extensions'),
  userRoot: userRootDir,
  userRootWithSep: userRootDir.endsWith(path.sep) ? userRootDir : `${userRootDir}${path.sep}`,
};

// --- Public URL ---
let publicUrl = null;
let publicOrigin = null;
if (env.PUBLIC_URL) {
  try {
    const url = new URL(env.PUBLIC_URL);
    publicUrl = url.href.replace(/\/$/, '');
    publicOrigin = url.origin;
  } catch (err) {
    console.warn(`[Config] Invalid PUBLIC_URL: ${env.PUBLIC_URL}`);
  }
}

// --- Additional (internal) origins ---
// Extra origins the app can be reached from (e.g. a LAN IP), comma-separated.
// They are considered valid so accessing the app that way doesn't raise the
// public-URL mismatch warning, and they're accepted by CORS. PUBLIC_URL remains
// the canonical URL used to build absolute links (shares, OIDC callbacks, WOPI).
const parseOriginList = (value, variableName = 'INTERNAL_URL') =>
  (typeof value === 'string' ? value.split(',') : [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch (err) {
        console.warn(`[Config] Invalid ${variableName} entry: ${entry}`);
        return null;
      }
    })
    .filter(Boolean);

const internalOrigins = parseOriginList(env.INTERNAL_URL);
// All origins the frontend should treat as valid (publicOrigin first, deduped).
const knownOrigins = [...new Set([publicOrigin, ...internalOrigins].filter(Boolean))];

// --- CORS ---
const buildCorsConfig = () => {
  if (env.CORS_ORIGINS) {
    if (env.CORS_ORIGINS === '*') return { allowAll: true, origins: [] };
    return {
      allowAll: false,
      origins: env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    };
  }
  if (knownOrigins.length) return { allowAll: false, origins: [...knownOrigins] };
  // Nothing configured: allow no cross-origin caller rather than reflecting
  // whatever origin asks, which combined with credentials:true would let any
  // site read authenticated responses. Same-origin requests carry no Origin
  // (or are permitted by the browser's own policy), so the normal setup —
  // frontend and API on one host — is unaffected. Declare CORS_ORIGINS,
  // PUBLIC_URL or INTERNAL_URL to allow a real cross-origin client.
  return { allowAll: false, origins: [] };
};

const corsConfig = buildCorsConfig();
const corsOptions = {
  origin: (origin, callback) => {
    if (corsConfig.allowAll || !origin || corsConfig.origins.includes(origin)) {
      callback(null, true);
    } else {
      // Important: do not throw here.
      // - Same-origin requests may still send an Origin header; if PUBLIC_URL is misconfigured,
      //   throwing breaks the whole app for users who access the instance via a different URL.
      // - Returning `false` disables CORS headers for this request (browser will block cross-origin),
      //   while still allowing non-CORS/same-origin clients to function.
      callback(null, false);
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};

// --- HTTP server timeouts ---
const requestTimeoutMs = (() => {
  const value = env.HTTP_TIMEOUT;
  return Number.isFinite(value) && value >= 0 ? value : 0;
})();

const uploadInactivityTimeoutMs = (() => {
  const value = env.UPLOAD_INACTIVITY_TIMEOUT;
  return Number.isFinite(value) && value >= 0 ? value : 120000;
})();

const uploadStorageReserveBytes = (() => {
  const value = parseByteSize(env.UPLOAD_STORAGE_RESERVE);
  return Number.isFinite(value) && value >= 0 ? value : 64 * 1024 * 1024;
})();

const tusUploadDir = env.TUS_UPLOAD_DIR
  ? path.resolve(env.TUS_UPLOAD_DIR)
  : path.join(cacheDir, 'tus-uploads');

const tusIncompleteUploadTtlMs = (() => {
  const value = env.TUS_INCOMPLETE_UPLOAD_TTL_MS;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 60 * 60 * 1000;
})();

const tusCleanupIntervalMs = (() => {
  const value = env.TUS_CLEANUP_INTERVAL_MS;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 10 * 60 * 1000;
})();

// --- Auth ---
// Determine auth mode: 'local', 'oidc', 'both', or 'disabled'
// If AUTH_MODE is not set, fall back to legacy behavior based on OIDC_ENABLED
const determineAuthMode = () => {
  if (env.AUTH_MODE) {
    const validModes = ['local', 'oidc', 'both', 'disabled'];
    if (!validModes.includes(env.AUTH_MODE)) {
      console.warn(`[Config] Invalid AUTH_MODE="${env.AUTH_MODE}". Using "both" as default.`);
      return 'both';
    }
    return env.AUTH_MODE;
  }
  return 'both';
};

const authMode = determineAuthMode();

const auth = {
  enabled: authMode === 'disabled' ? false : env.AUTH_ENABLED !== false,
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionMaxAgeMs: env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000, // Convert days to milliseconds
  mode: authMode,
  oidc: {
    enabled: env.OIDC_ENABLED ?? null,
    issuer: env.OIDC_ISSUER,
    authorizationURL: env.OIDC_AUTHORIZATION_URL,
    tokenURL: env.OIDC_TOKEN_URL,
    userInfoURL: env.OIDC_USERINFO_URL,
    logoutURL: env.OIDC_LOGOUT_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    callbackUrl: env.OIDC_CALLBACK_URL || (publicUrl ? `${publicUrl}/callback` : null),
    scopes: parseScopes(env.OIDC_SCOPES) || null,
    adminGroups: parseScopes(env.OIDC_ADMIN_GROUPS) || null,
    requireEmailVerified: env.OIDC_REQUIRE_EMAIL_VERIFIED,
    autoCreateUsers: env.OIDC_AUTO_CREATE_USERS,
  },
};

const deriveSecret = (purpose) =>
  crypto.createHmac('sha256', auth.sessionSecret).update(`nextexplorer:${purpose}`).digest('hex');

// --- Search ---
const searchMaxFileSizeBytes = (() => {
  const parsed = parseByteSize(env.SEARCH_MAX_FILESIZE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
})();

// --- Uploads ---
// Ceilings for direct (non-chunked) uploads. They exist so a single request
// cannot stream until the disk is full; they are generous on purpose, since
// large files are a normal use of a file manager. Chunked uploads have their
// own storage guard in the TUS service.
/**
 * What the inline text editor opens, and what a JSON request body may weigh.
 *
 * They are one decision rather than two. The editor sends a file back through
 * a JSON body when it saves it, so a body limit under the size the editor
 * opens produces a file that opens and cannot be saved — answered with
 * "request entity too large", which names neither setting.
 *
 * Escaping is why the body has to be worth more than the file: in the worst
 * case every character of the content is a quote, a backslash or a newline and
 * becomes two, and the path travels in the same body. A file whose bytes would
 * expand further than that is one the editor refuses to open anyway, as
 * binary.
 */
const JSON_ESCAPE_WORST_CASE = 2;
const JSON_BODY_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_JSON_BODY_BYTES = 8 * 1024 * 1024;

const bodyNeededFor = (fileBytes) => fileBytes * JSON_ESCAPE_WORST_CASE + JSON_BODY_OVERHEAD_BYTES;
const fileAllowedBy = (bodyBytes) =>
  Math.max(0, Math.floor((bodyBytes - JSON_BODY_OVERHEAD_BYTES) / JSON_ESCAPE_WORST_CASE));

const { editorMaxFileSizeBytes, maxJsonBodyBytes } = (() => {
  const parsedEditor = parseByteSize(env.EDITOR_MAX_FILESIZE);
  // Default: 2 MiB if not configured or invalid
  const editorAsked =
    Number.isFinite(parsedEditor) && parsedEditor > 0 ? parsedEditor : 2 * 1024 * 1024;

  const parsedBody = parseByteSize(env.MAX_JSON_BODY_SIZE);
  const bodyWasChosen = Number.isFinite(parsedBody) && parsedBody > 0;

  // A body limit someone set is a ceiling they meant — it is a guard, not a
  // detail — so it is never raised from here. The editor is what gives way,
  // and it gives way by refusing to open what it could not save back.
  if (bodyWasChosen) {
    const allowed = fileAllowedBy(parsedBody);
    if (editorAsked > allowed) {
      logger.warn(
        { editorAsked, loweredTo: allowed, maxJsonBodyBytes: parsedBody },
        'EDITOR_MAX_FILESIZE is larger than MAX_JSON_BODY_SIZE can carry back and has been ' +
          'lowered to match; the editor would otherwise open files it could not save'
      );
    }
    return { editorMaxFileSizeBytes: Math.min(editorAsked, allowed), maxJsonBodyBytes: parsedBody };
  }

  // Nobody chose the body limit, so the editor's size is the only wish there
  // is to honour: the default body limit rises to carry it.
  const needed = bodyNeededFor(editorAsked);
  if (needed > DEFAULT_JSON_BODY_BYTES) {
    logger.info(
      { editorMaxFileSizeBytes: editorAsked, maxJsonBodyBytes: needed },
      'Raised the JSON body limit above its default so the text editor can save what it opens'
    );
  }

  return {
    editorMaxFileSizeBytes: editorAsked,
    maxJsonBodyBytes: Math.max(DEFAULT_JSON_BODY_BYTES, needed),
  };
})();

const uploads = {
  maxJsonBodyBytes,
  maxDirectUploadBytes: (() => {
    const parsed = parseByteSize(env.MAX_DIRECT_UPLOAD_SIZE);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 64 * 1024 * 1024 * 1024;
  })(),
  maxFilesPerRequest: env.MAX_FILES_PER_UPLOAD,
};

// --- OnlyOffice ---
const onlyoffice = {
  serverUrl: env.ONLYOFFICE_URL?.replace(/\/$/, '') || null,
  // Never hand the session signing secret to an external service. When no
  // dedicated secret is configured, derive a distinct one so the value shared
  // with the Document Server cannot be used to forge session cookies.
  //
  // This used to fall back to SESSION_SECRET verbatim, so a deployment that set
  // the Document Server's JWT_SECRET to that value worked without ever setting
  // ONLYOFFICE_SECRET. It no longer matches — see the warning emitted below.
  secret: env.ONLYOFFICE_SECRET || deriveSecret('onlyoffice'),
  // Extra origins the Document Server may serve saved documents from, for
  // deployments where it reports a different host than the one we call.
  downloadOrigins: parseOriginList(env.ONLYOFFICE_DOWNLOAD_ORIGINS, 'ONLYOFFICE_DOWNLOAD_ORIGINS'),
  lang: env.ONLYOFFICE_LANG,
  forceSave: env.ONLYOFFICE_FORCE_SAVE,
  forceSaveTimeoutMs: Math.min(30000, Math.max(7000, env.ONLYOFFICE_FORCE_SAVE_TIMEOUT_MS)),
  autoSaveIntervalMs: Math.min(300000, Math.max(0, env.ONLYOFFICE_AUTO_SAVE_INTERVAL_MS)),
  extensions: env.ONLYOFFICE_FILE_EXTENSIONS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// Silent JWT mismatches surface to the user as "Document security token is not
// correctly configured", with nothing in the logs pointing at the cause.
if (onlyoffice.serverUrl && !env.ONLYOFFICE_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] ONLYOFFICE_URL is set without ONLYOFFICE_SECRET. A derived secret is used, ' +
      'which will not match the Document Server unless its JWT_SECRET is set to the same ' +
      'value. Set ONLYOFFICE_SECRET on both sides.'
  );
}

// --- Thumbnails served outside /api ---
// Its own secret, so a leaked thumbnail URL cannot be turned into anything
// else. Regenerated on restart when no session secret is configured, which
// only means already-loaded pages refetch their thumbnails.
const thumbnailAccess = {
  secret: deriveSecret('thumbnails'),
};

// --- Collabora (WOPI) ---
const collaboraBaseUrl = env.COLLABORA_URL?.replace(/\/$/, '') || null;
const collaboraDiscoveryUrl =
  env.COLLABORA_DISCOVERY_URL?.replace(/\/$/, '') ||
  (collaboraBaseUrl ? `${collaboraBaseUrl}/hosting/discovery` : null);

const collabora = {
  url: collaboraBaseUrl,
  discoveryUrl: collaboraDiscoveryUrl,
  secret: env.COLLABORA_SECRET || null,
  lang: env.COLLABORA_LANG,
  extensions: env.COLLABORA_FILE_EXTENSIONS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// --- Editor ---
const editor = {
  extensions: parseExtensionList(env.EDITOR_EXTENSIONS),
  maxFileSizeBytes: editorMaxFileSizeBytes,
};

// --- Archive extraction ---
// Extensions the app is willing to offer for extraction, provided the local
// 7-Zip build actually supports them (checked at runtime by archiveService).
// A whitelist keeps container-ish formats 7-Zip can technically read (docx,
// apk, exe…) from being presented as archives in the UI.
const DEFAULT_ARCHIVE_EXTENSIONS = [
  '7z',
  'zip',
  'iso',
  'rar',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'cab',
  'wim',
  'cpio',
  'rpm',
  'deb',
  'z',
  'lzh',
  'arj',
  'zst',
];

const archives = (() => {
  const raw = String(env.ARCHIVE_EXTENSIONS || '').trim();
  // Extraction guards, generous enough for real archives but low enough that a
  // crafted one cannot fill the volume before anyone notices.
  const limits = {
    maxExtractedBytes: (() => {
      const parsed = parseByteSize(env.MAX_EXTRACTED_ARCHIVE_SIZE);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 1024 * 1024 * 1024;
    })(),
    maxEntries: env.MAX_ARCHIVE_ENTRIES,
  };
  if (!raw) return { extensions: DEFAULT_ARCHIVE_EXTENSIONS, ...limits };
  // 'zip,iso' replaces the default list; '+udf,squashfs' extends it.
  const extend = raw.startsWith('+');
  const list = parseExtensionList(extend ? raw.slice(1) : raw);
  return {
    extensions: extend ? [...new Set([...DEFAULT_ARCHIVE_EXTENSIONS, ...list])] : list,
    ...limits,
  };
})();

// --- Terminal ---
const terminal = {
  extensions: parseExtensionList(env.TERMINAL_FILE_EXTENSIONS),
};

// --- Favorites ---
const favorites = {
  defaultIcon: env.FAVORITES_DEFAULT_ICON,
};

// --- Personal folders ---
const personal = {
  userFolderNameOrder: parseUserFolderNameOrder(env.USER_FOLDER_NAME_ORDER),
};

// --- Hidden file patterns ---
const hiddenFiles = parseHiddenFilePatterns(env.HIDDEN_FILE_PATTERNS);
// --- Folder size index ---
const VALID_FOLDER_SIZE_MODES = new Set(['off', 'shallow', 'full']);
const folderSizeMode = VALID_FOLDER_SIZE_MODES.has(env.FOLDER_SIZE_MODE)
  ? env.FOLDER_SIZE_MODE
  : 'off';

const folderSize = {
  mode: folderSizeMode,
  enabled: folderSizeMode !== 'off',
  envExcludedPaths: env.FOLDER_SIZE_EXCLUDE_PATHS,
  concurrency: env.FOLDER_SIZE_CONCURRENCY,
  networkConcurrency: env.FOLDER_SIZE_NETWORK_CONCURRENCY,
  flushMs: env.FOLDER_SIZE_FLUSH_MS,
  reconcileMs: env.FOLDER_SIZE_RECONCILE_MS,
  reconcileMinMs: env.FOLDER_SIZE_RECONCILE_MIN_MS,
  reconcileMaxMs: env.FOLDER_SIZE_RECONCILE_MAX_MS,
  reconcileBatch: env.FOLDER_SIZE_RECONCILE_BATCH,
  reconcilePauseMs: env.FOLDER_SIZE_RECONCILE_PAUSE_MS,
  reconcileMaxDirectories:
    Number.isFinite(env.FOLDER_SIZE_RECONCILE_MAX_DIRECTORIES) &&
    env.FOLDER_SIZE_RECONCILE_MAX_DIRECTORIES >= 0
      ? Math.floor(env.FOLDER_SIZE_RECONCILE_MAX_DIRECTORIES)
      : 200,
  subtreeBatch:
    Number.isFinite(env.FOLDER_SIZE_SUBTREE_BATCH) && env.FOLDER_SIZE_SUBTREE_BATCH > 0
      ? Math.floor(env.FOLDER_SIZE_SUBTREE_BATCH)
      : env.FOLDER_SIZE_RECONCILE_BATCH,
  subtreePauseMs:
    Number.isFinite(env.FOLDER_SIZE_SUBTREE_PAUSE_MS) && env.FOLDER_SIZE_SUBTREE_PAUSE_MS >= 0
      ? env.FOLDER_SIZE_SUBTREE_PAUSE_MS
      : env.FOLDER_SIZE_RECONCILE_PAUSE_MS,
  subtreeSlowLogMs: Math.max(0, env.FOLDER_SIZE_SUBTREE_SLOW_LOG_MS),
  ioTimeoutMs:
    Number.isFinite(env.FOLDER_SIZE_IO_TIMEOUT_MS) && env.FOLDER_SIZE_IO_TIMEOUT_MS >= 0
      ? env.FOLDER_SIZE_IO_TIMEOUT_MS
      : 30000,
  maxStalledIo:
    Number.isFinite(env.FOLDER_SIZE_MAX_STALLED_IO) && env.FOLDER_SIZE_MAX_STALLED_IO > 0
      ? Math.floor(env.FOLDER_SIZE_MAX_STALLED_IO)
      : 2,
  rebuild: env.FOLDER_SIZE_REBUILD,
};
// --- Runtime diagnostics ---
const atLeast = (value, minimum, fallback) =>
  Number.isFinite(value) && value >= minimum ? value : fallback;

const performanceDiagnostics = {
  enabled: env.PERFORMANCE_DIAGNOSTICS_ENABLED,
  intervalMs: atLeast(env.PERFORMANCE_DIAGNOSTICS_INTERVAL_MS, 5000, 15000),
  logEveryInterval: env.PERFORMANCE_DIAGNOSTICS_LOG_EVERY_INTERVAL,
  cpuThreshold: atLeast(env.PERFORMANCE_DIAGNOSTICS_CPU_THRESHOLD, 1, 75),
  rssThresholdMb: atLeast(env.PERFORMANCE_DIAGNOSTICS_RSS_THRESHOLD_MB, 1, 768),
  eventLoopDelayThresholdMs: atLeast(env.PERFORMANCE_DIAGNOSTICS_EVENT_LOOP_DELAY_MS, 1, 250),
};
// --- Shares ---
const shares = {
  enabled: env.SHARES_ENABLED,
  tokenLength: env.SHARES_TOKEN_LENGTH,
  maxSharesPerUser: env.SHARES_MAX_PER_USER,
  defaultExpiryDays: env.SHARES_DEFAULT_EXPIRY_DAYS,
  guestSessionHours: env.SHARES_GUEST_SESSION_HOURS,
  allowPasswordProtection: env.SHARES_ALLOW_PASSWORD,
  allowAnonymous: env.SHARES_ALLOW_ANONYMOUS,
};

// --- Demo sign-in ---
// A password served to anyone who loads the sign-in page. That is right for a
// public demo and wrong everywhere else, so it takes three deliberate things at
// once: demo mode on, and both halves of a credential named for this purpose.
// Any one of them missing and nothing is published — no partial state, no way
// to arrive here by setting something that meant something else.
const demoLoginRequested = Boolean(env.DEMO_LOGIN_EMAIL || env.DEMO_LOGIN_PASSWORD);
const demoLogin =
  env.DEMO_MODE && env.DEMO_LOGIN_EMAIL && env.DEMO_LOGIN_PASSWORD
    ? { email: env.DEMO_LOGIN_EMAIL, password: env.DEMO_LOGIN_PASSWORD }
    : null;

if (demoLogin) {
  console.warn(
    `[Config] Demo sign-in enabled: ${demoLogin.email} and its password are served to anyone who opens the sign-in page.`
  );
} else if (demoLoginRequested && !env.DEMO_MODE) {
  console.warn(
    '[Config] DEMO_LOGIN_EMAIL/DEMO_LOGIN_PASSWORD are set but DEMO_MODE is not enabled; no credentials are published and the sign-in form is not pre-filled.'
  );
} else if (demoLoginRequested) {
  console.warn(
    '[Config] DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD must both be set; the sign-in form will not be pre-filled.'
  );
}

// --- Main Export ---
module.exports = {
  port: env.PORT,
  address: env.ADDRESS,
  http: {
    requestTimeoutMs,
  },
  upload: {
    inactivityTimeoutMs: uploadInactivityTimeoutMs,
    storageReserveBytes: uploadStorageReserveBytes,
    tusUploadDir,
    tusIncompleteUploadTtlMs,
    tusCleanupIntervalMs,
  },
  directories,

  files: {
    passwordConfig: path.join(configDir, 'app-config.json'),
  },

  public: { url: publicUrl, origin: publicOrigin, origins: knownOrigins },

  extensions: {
    images: constants.IMAGE_EXTENSIONS,
    rawImages: constants.RAW_IMAGE_EXTENSIONS,
    videos: constants.VIDEO_EXTENSIONS,
    audios: constants.AUDIO_EXTENSIONS,
    documents: constants.DOCUMENT_EXTENSIONS,
    previewable: constants.PREVIEWABLE_EXTENSIONS,
  },

  excludedFiles: constants.EXCLUDED_FILES,
  mimeTypes: constants.MIME_TYPES,
  corsOptions,

  auth,
  demoLogin,

  search: {
    deep: env.SEARCH_DEEP ?? true,
    ripgrep: env.SEARCH_RIPGREP ?? true,
    maxFileSize: env.SEARCH_MAX_FILESIZE,
    maxFileSizeBytes: searchMaxFileSizeBytes,
    // How long one search may spend looking before answering with what it has.
    // Reading a large tree to be certain there is nothing more is worse than
    // an answer that arrives.
    timeoutMs:
      Number.isFinite(env.SEARCH_TIMEOUT_MS) && env.SEARCH_TIMEOUT_MS > 0
        ? env.SEARCH_TIMEOUT_MS
        : 5000,
    index: {
      // Off unless asked for: an index is a promise to keep something up to
      // date, and that is a decision rather than a default.
      enabled: env.SEARCH_INDEX === true,
      // How many documents share one transaction. Small on purpose: a long
      // transaction is a long stretch of the only thread the server has.
      batch:
        Number.isFinite(env.SEARCH_INDEX_BATCH) && env.SEARCH_INDEX_BATCH > 0
          ? Math.floor(env.SEARCH_INDEX_BATCH)
          : 25,
      // The share of one core a pass may take. This replaces a pause counted
      // per batch, which paced nothing: the cost of a batch is the cost of the
      // files in it, and a fixed pause after an unbounded amount of work is
      // not a limit on anything. A share of time is.
      cpuPercent:
        Number.isFinite(env.SEARCH_INDEX_CPU_PERCENT) &&
        env.SEARCH_INDEX_CPU_PERCENT > 0 &&
        env.SEARCH_INDEX_CPU_PERCENT <= 100
          ? env.SEARCH_INDEX_CPU_PERCENT
          : 25,
      // Folders the index has no business reading. The volume is the user's,
      // and what is worth searching in it is theirs to say: a build tree, a
      // mail spool, a backup of a machine — hundreds of thousands of files
      // each, none of them anything anyone searches for by content.
      //
      // Named rather than guessed at. A list of "obviously noise" directories
      // baked in here would decide, for everyone, that something is not worth
      // finding — and with the index answering in place of the live scan, that
      // decision would be invisible.
      exclude: String(env.SEARCH_INDEX_EXCLUDE || '')
        .split(/[\n,]/)
        .map((entry) => entry.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean),
      // What a pass may add to the process before it gives up and waits for
      // the next one. Every other bound is a belief about what a file costs;
      // this is what holds when one of those beliefs is wrong.
      //
      // A hundred and twenty-eight megabytes because a pass over two hundred
      // thousand documents was measured growing sixty, and a ceiling twice
      // what the work needs is a guard. Five hundred was not a guard: nothing
      // reaches it, so nothing is ever caught by it.
      memoryBudgetBytes:
        Number.isFinite(env.SEARCH_INDEX_MEMORY_MB) && env.SEARCH_INDEX_MEMORY_MB > 0
          ? env.SEARCH_INDEX_MEMORY_MB * 1024 * 1024
          : 128 * 1024 * 1024,
      reconcileMs:
        Number.isFinite(env.SEARCH_INDEX_RECONCILE_MS) && env.SEARCH_INDEX_RECONCILE_MS > 0
          ? env.SEARCH_INDEX_RECONCILE_MS
          : 60 * 60 * 1000,
    },
  },

  thumbnails: { size: 200, quality: 70 },
  uploads,
  onlyoffice,
  thumbnailAccess,
  collabora,
  editor,
  terminal,
  favorites,
  shares,
  hiddenFiles,
  folderSize,
  performanceDiagnostics,
  archives,

  features: {
    volumeUsage: env.SHOW_VOLUME_USAGE,
    folderSizeMode,
    personalFolders: env.USER_DIR_ENABLED,
    userVolumes: env.USER_VOLUMES,
    shares: env.SHARES_ENABLED,
    skipHome: env.SKIP_HOME,
    terminal: env.TERMINAL_ENABLED,
  },

  logging: {
    level: loggingConfig.level,
    isDebug: loggingConfig.isDebug,
    enableHttpLogging: loggingConfig.enableHttpLogging,
  },

  personal,
};
