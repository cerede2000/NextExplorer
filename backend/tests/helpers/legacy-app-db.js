/**
 * The application database as earlier releases left it.
 *
 * An upgrade test is only as good as the database it upgrades. These schemas
 * are not reconstructed from the current migrations — those create today's
 * tables, which is exactly what an older installation does not have — but from
 * what each tagged release creates on a clean start, table by table and column
 * by column. Where two releases differ only by a few columns, the difference is
 * spelled out below rather than hidden in a copy.
 *
 * The shapes that matter, and why:
 *
 * - schema 2 (1.1.x): one `users` table carrying the sign-in method itself;
 *   schema 3 split it into accounts and sign-in methods.
 * - schema 3 (1.1.8 – 1.2.0): favorites still lived in app-config.json.
 * - schema 6 (2.0.3 – 2.1.1): settings still lived in app-config.json, and a
 *   share counted its visits in `download_count`.
 * - schema 8 (2.1.2a – 2.2.7, the last upstream release): no per-operation
 *   share permissions, no audit columns, none of the later feature tables.
 * - schema 13 (3.0.0): share permissions but no `allow_download` column, which
 *   arrived after schema 10 had already been recorded.
 * - schema 14 (3.0.1 – 3.1.1): folder preferences as rows, no personal folder
 *   names.
 * - schema 16 (a build between 3.1.2 and 3.2.0): the first search index, whose
 *   documents had no `dir` column, and still no `allow_download`.
 * - schema 17 (3.2.0 – 3.5.0, the last release): everything but the trash and
 *   the file versions.
 * - schema 18 (integration builds before the release): the trash as it first
 *   shipped, before a restore recorded which entry of a folder it was taking.
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const META = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

// Schema 1 and 2: the sign-in method is a column of the account.
const ACCOUNTS_V2 = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('local','oidc')),
    username TEXT UNIQUE,
    password_hash TEXT,
    password_algo TEXT,
    oidc_issuer TEXT,
    oidc_sub TEXT,
    display_name TEXT,
    email TEXT,
    roles TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_users_oidc ON users(oidc_issuer, oidc_sub);
  CREATE INDEX idx_users_username ON users(username);
  CREATE TABLE auth_locks (
    key TEXT PRIMARY KEY, -- normalized username or subject key
    failed_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
`;

// Schema 3 onwards: accounts and the ways to sign in to them.
const accountsV3 = ({ personalFolder = false } = {}) => `
  CREATE TABLE auth_locks (
    key TEXT PRIMARY KEY, -- normalized username or subject key
    failed_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    email_verified INTEGER DEFAULT 0,
    username TEXT,
    display_name TEXT,
    roles TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL${personalFolder ? ',\n    personal_folder_name TEXT' : ''}
  );
  CREATE TABLE auth_methods (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    method_type TEXT NOT NULL CHECK(method_type IN ('local_password', 'oidc')),
    password_hash TEXT,
    password_algo TEXT DEFAULT 'bcrypt',
    provider_issuer TEXT,
    provider_sub TEXT,
    provider_name TEXT,
    enabled INTEGER DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_users_email ON users(email);
  CREATE INDEX idx_auth_methods_user ON auth_methods(user_id);
  CREATE UNIQUE INDEX idx_auth_methods_oidc ON auth_methods(provider_issuer, provider_sub) WHERE method_type = 'oidc';
  CREATE INDEX idx_auth_methods_type ON auth_methods(method_type);
  ${personalFolder ? 'CREATE UNIQUE INDEX idx_users_personal_folder ON users(personal_folder_name);' : ''}
`;

const FAVORITES = `
  CREATE TABLE favorites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    label TEXT,
    icon TEXT DEFAULT 'outline:StarIcon',
    color TEXT DEFAULT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX idx_favorites_user_path ON favorites(user_id, path);
  CREATE INDEX idx_favorites_user ON favorites(user_id);
`;

/**
 * The shares table of each era. `operations` are the four per-operation
 * permissions and the audit columns that shipped with 3.0.0; `download` is the
 * `allow_download` column that followed them.
 */
const shares = ({ operations = false, download = false } = {}) => `
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    share_token TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    source_space TEXT NOT NULL,
    source_path TEXT NOT NULL,
    is_directory INTEGER NOT NULL,
    access_mode TEXT NOT NULL CHECK(access_mode IN ('readonly', 'readwrite')),
    ${
      operations
        ? `allow_delete INTEGER NOT NULL DEFAULT 1,
    allow_create_folder INTEGER NOT NULL DEFAULT 1,
    allow_create_file INTEGER NOT NULL DEFAULT 1,
    allow_upload INTEGER NOT NULL DEFAULT 1,`
        : ''
    }
    ${download ? 'allow_download INTEGER NOT NULL DEFAULT 1,' : ''}
    sharing_type TEXT NOT NULL CHECK(sharing_type IN ('anyone', 'users')),
    password_hash TEXT,
    expires_at TEXT,
    label TEXT,
    ${operations ? 'access_count INTEGER DEFAULT 0,' : ''}
    download_count INTEGER DEFAULT 0,
    last_accessed_at TEXT,
    ${
      operations
        ? `last_access_ip TEXT,
    last_downloaded_at TEXT,
    last_download_ip TEXT,`
        : ''
    }
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE share_permissions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(share_id, user_id)
  );
  CREATE TABLE guest_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_shares_owner ON shares(owner_id);
  CREATE INDEX idx_shares_token ON shares(share_token);
  CREATE INDEX idx_shares_expires ON shares(expires_at);
  CREATE INDEX idx_shares_source ON shares(source_space, source_path);
  CREATE INDEX idx_share_permissions_share ON share_permissions(share_id);
  CREATE INDEX idx_share_permissions_user ON share_permissions(user_id);
  CREATE INDEX idx_guest_sessions_share ON guest_sessions(share_id);
  CREATE INDEX idx_guest_sessions_expires ON guest_sessions(expires_at);
`;

const USER_VOLUMES = `
  CREATE TABLE user_volumes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    access_mode TEXT NOT NULL CHECK(access_mode IN ('readonly', 'readwrite')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_user_volumes_user ON user_volumes(user_id);
  CREATE UNIQUE INDEX idx_user_volumes_user_path ON user_volumes(user_id, path);
`;

const SETTINGS = `
  CREATE TABLE system_settings (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('branding', 'system')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(category, key)
  );
  CREATE TABLE user_settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, key)
  );
  CREATE INDEX idx_system_settings_category ON system_settings(category);
  CREATE INDEX idx_user_settings_user ON user_settings(user_id);
`;

// Schemas 9 to 13, as 3.0.0 created them.
const FEATURES_V13 = `
  CREATE TABLE folder_size_index (
    path_hash         TEXT PRIMARY KEY,
    parent_hash       TEXT,
    volume            TEXT NOT NULL,
    relative_path     TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL DEFAULT 0,
    entry_count       INTEGER NOT NULL DEFAULT 0,
    last_delta_at     DATETIME,
    last_full_scan_at DATETIME,
    dirty             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_folder_size_parent ON folder_size_index(parent_hash);
  CREATE INDEX idx_folder_size_volume ON folder_size_index(volume);
  CREATE TABLE onlyoffice_document_keys (
    relative_path TEXT PRIMARY KEY,
    document_key  TEXT NOT NULL,
    signature     TEXT NOT NULL,
    created_at    DATETIME,
    expires_at    DATETIME
  );
  CREATE TABLE onlyoffice_editor_sessions (
    id               TEXT PRIMARY KEY,
    document_key     TEXT NOT NULL,
    relative_path    TEXT NOT NULL,
    absolute_path    TEXT NOT NULL,
    user_id          TEXT,
    guest_session_id TEXT,
    expires_at       DATETIME NOT NULL
  );
  CREATE INDEX idx_onlyoffice_sessions_expiry ON onlyoffice_editor_sessions(expires_at);
  CREATE TABLE recent_destinations (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    used_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, path)
  );
`;

const FOLDER_PREFERENCES = `
  CREATE TABLE folder_preferences (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sort_by TEXT,
    sort_order TEXT,
    view_mode TEXT,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, path)
  );
  CREATE INDEX idx_folder_preferences_path ON folder_preferences(path);
`;

// The first search index: documents known by path alone.
const SEARCH_V16 = `
  CREATE TABLE search_documents (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX idx_search_documents_path ON search_documents(path);
  CREATE VIRTUAL TABLE search_terms
    USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`;

// Schema 17: the same index, by folder.
const SEARCH_V17 = `
  CREATE TABLE search_documents (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL DEFAULT '',
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX idx_search_documents_path ON search_documents(path);
  CREATE INDEX idx_search_documents_dir ON search_documents(dir);
  CREATE VIRTUAL TABLE search_terms
    USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`;

// Schema 18 as the trash first shipped on integration: no `restore_entry`, no
// `trash_shares`.
const EARLY_TRASH = `
  CREATE TABLE trash_zones (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_trash_zones_root ON trash_zones(root);
  CREATE TABLE trash_items (
    id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL,
    state TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    original_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    logical_path TEXT,
    space TEXT,
    deleted_by TEXT,
    deleted_by_label TEXT,
    owner_user_id TEXT,
    restore_path TEXT,
    deleted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_trash_items_zone ON trash_items(zone_id, deleted_at);
  CREATE INDEX idx_trash_items_deleted_by ON trash_items(deleted_by);
  CREATE INDEX idx_trash_items_owner ON trash_items(owner_user_id);
  CREATE TABLE trash_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL,
    item_id TEXT,
    item_name TEXT,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_trash_events_zone ON trash_events(zone_id, id);
`;

const SCHEMAS = {
  2: { release: '1.1.x', ddl: [META, ACCOUNTS_V2] },
  3: { release: '1.2.0', ddl: [META, accountsV3()] },
  6: { release: '2.1.1', ddl: [META, accountsV3(), FAVORITES, shares(), USER_VOLUMES] },
  8: { release: '2.2.7', ddl: [META, accountsV3(), FAVORITES, shares(), USER_VOLUMES, SETTINGS] },
  13: {
    release: '3.0.0',
    ddl: [
      META,
      accountsV3(),
      FAVORITES,
      shares({ operations: true }),
      USER_VOLUMES,
      SETTINGS,
      FEATURES_V13,
    ],
  },
  14: {
    release: '3.1.0',
    ddl: [
      META,
      accountsV3(),
      FAVORITES,
      shares({ operations: true }),
      USER_VOLUMES,
      SETTINGS,
      FEATURES_V13,
      FOLDER_PREFERENCES,
    ],
  },
  16: {
    release: 'a build between 3.1.2 and 3.2.0',
    ddl: [
      META,
      accountsV3({ personalFolder: true }),
      FAVORITES,
      shares({ operations: true }),
      USER_VOLUMES,
      SETTINGS,
      FEATURES_V13,
      FOLDER_PREFERENCES,
      SEARCH_V16,
    ],
  },
  17: {
    release: '3.5.0',
    ddl: [
      META,
      accountsV3({ personalFolder: true }),
      FAVORITES,
      shares({ operations: true, download: true }),
      USER_VOLUMES,
      SETTINGS,
      FEATURES_V13,
      FOLDER_PREFERENCES,
      SEARCH_V17,
    ],
  },
  18: {
    release: 'the first integration builds with the trash',
    ddl: [
      META,
      accountsV3({ personalFolder: true }),
      FAVORITES,
      shares({ operations: true, download: true }),
      USER_VOLUMES,
      SETTINGS,
      FEATURES_V13,
      FOLDER_PREFERENCES,
      SEARCH_V17,
      EARLY_TRASH,
    ],
  },
};

/**
 * Create `app.db` in a configuration directory as the release that recorded
 * `schemaVersion` left it, and hand back an open connection so the test can put
 * that installation's rows in. Close it before the application opens the file.
 */
const createLegacyDatabase = (configDir, schemaVersion) => {
  const schema = SCHEMAS[schemaVersion];
  if (!schema) throw new Error(`No recorded schema for version ${schemaVersion}`);

  fs.mkdirSync(configDir, { recursive: true });
  const db = new Database(path.join(configDir, 'app.db'));
  db.exec(schema.ddl.join('\n'));
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(schemaVersion)
  );
  return db;
};

/** A connection of the test's own to a database, independent of the application's. */
const openDatabaseFile = (configDir) => new Database(path.join(configDir, 'app.db'));

/** Every table, index and trigger, with its definition, for comparing two states. */
const describeSchema = (db) =>
  db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`
    )
    .all();

module.exports = {
  SCHEMAS,
  createLegacyDatabase,
  openDatabaseFile,
  describeSchema,
};
