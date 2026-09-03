const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { directories, files, favorites } = require('../config');
const { ensureDir } = require('../utils/fsUtils');
const logger = require('../utils/logger');

let dbInstance = null;

const getDbPath = () => {
  const configDir = directories.config;
  // Generic app database for auth, shares, and user settings.
  return path.join(configDir, 'app.db');
};

const { generateId } = require('../utils/ids');

const DEFAULT_FAVORITE_ICON = favorites.defaultIcon;

const addColumnIfMissing = (db, tableName, columnName, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
};

// DDL for the folder size index. Kept as a constant so it can be applied both by
// the versioned migration (clean installs) and idempotently on every open — the
// latter guarantees the table exists even when the recorded schema_version was
// already advanced past this migration by a different build sharing /config.
const FOLDER_SIZE_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS folder_size_index (
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
  CREATE INDEX IF NOT EXISTS idx_folder_size_parent ON folder_size_index(parent_hash);
  CREATE INDEX IF NOT EXISTS idx_folder_size_volume ON folder_size_index(volume);
`;

// The identity the Document Server files an open document under. Shared by
// everyone who has it open, which is what lets them edit together; see
// onlyofficeDocumentKeyService for why it has to outlive their saves.
//
// Same idempotent treatment as the index above: a /config directory shared with
// a different build may already record a later schema version.
const ONLYOFFICE_DOCUMENT_KEYS_DDL = `
  CREATE TABLE IF NOT EXISTS onlyoffice_document_keys (
    relative_path TEXT PRIMARY KEY,
    document_key  TEXT NOT NULL,
    signature     TEXT NOT NULL,
    created_at    DATETIME,
    expires_at    DATETIME
  );
`;

// Where a document is while an editor has it open. Outlives the process on
// purpose: a restart mid-edit used to lose a rename, and the next save then
// recreated the old name beside the new one.
const ONLYOFFICE_EDITOR_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS onlyoffice_editor_sessions (
    id               TEXT PRIMARY KEY,
    document_key     TEXT NOT NULL,
    relative_path    TEXT NOT NULL,
    absolute_path    TEXT NOT NULL,
    user_id          TEXT,
    guest_session_id TEXT,
    expires_at       DATETIME NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_onlyoffice_sessions_expiry ON onlyoffice_editor_sessions(expires_at);
`;

const ensureShareOperationPermissionColumns = (db) => {
  addColumnIfMissing(db, 'shares', 'allow_delete', 'allow_delete INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(
    db,
    'shares',
    'allow_create_folder',
    'allow_create_folder INTEGER NOT NULL DEFAULT 1'
  );
  addColumnIfMissing(
    db,
    'shares',
    'allow_create_file',
    'allow_create_file INTEGER NOT NULL DEFAULT 1'
  );
  addColumnIfMissing(db, 'shares', 'allow_upload', 'allow_upload INTEGER NOT NULL DEFAULT 1');
  // Defaults to 1 so every share that already exists keeps working exactly as
  // it did: withholding downloads is something an owner opts into, never
  // something a migration decides for them.
  addColumnIfMissing(db, 'shares', 'allow_download', 'allow_download INTEGER NOT NULL DEFAULT 1');
};

/**
 * Where a user has recently moved or copied things to.
 *
 * Kept as history rather than a preference: the point is that the folders you
 * actually use rise to the top of the destination picker without anyone
 * curating a list. One row per user and path — using a destination again moves
 * it up rather than adding a duplicate.
 */
const RECENT_DESTINATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS recent_destinations (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    used_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, path)
  );
`;

/**
 * What a user chose for one folder: how to sort it, how to show it.
 *
 * A row per folder rather than one JSON blob per user. The blob had to be
 * capped — it was read and rewritten whole on every change, and shipped
 * entire on every load — so the hundred-and-first folder silently forgot the
 * oldest. More importantly, a blob cannot be cleaned up: deleting a folder
 * could not remove what everyone else had chosen for it, and renaming one left
 * the preferences behind on a path that no longer existed.
 */
const FOLDER_PREFERENCES_DDL = `
  CREATE TABLE IF NOT EXISTS folder_preferences (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sort_by TEXT,
    sort_order TEXT,
    view_mode TEXT,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, path)
  );
  CREATE INDEX IF NOT EXISTS idx_folder_preferences_path ON folder_preferences(path);
`;

/**
 * Carry per-folder preferences out of the JSON blob they used to live in.
 *
 * They were two maps under `user_settings` — one for sorting, one for the view
 * mode — capped at a hundred entries each because the whole blob was rewritten
 * on every change. As rows they need no cap, and they can finally be cleaned up
 * when the folder they describe is deleted or renamed.
 *
 * Best-effort: a preference that fails to migrate costs a folder its remembered
 * sort, which is not worth failing a startup over.
 */
const migrateFolderPreferencesFromUserSettings = (db) => {
  let rows = [];
  try {
    rows = db
      .prepare(
        "SELECT user_id, key, value FROM user_settings WHERE key IN ('folderSorts', 'folderViews')"
      )
      .all();
  } catch (error) {
    logger.debug({ err: error }, '[DB Migration] No folder preferences to carry over');
    return;
  }

  const merged = new Map();
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    for (const [folderPath, entry] of Object.entries(parsed)) {
      if (!folderPath || !entry || typeof entry !== 'object') continue;

      const key = `${row.user_id}\u0000${folderPath}`;
      const current = merged.get(key) || {
        userId: row.user_id,
        path: folderPath,
        sortBy: null,
        sortOrder: null,
        viewMode: null,
        updatedAt: 0,
      };

      if (row.key === 'folderSorts' && typeof entry.by === 'string') {
        current.sortBy = entry.by;
        current.sortOrder = entry.order === 'desc' ? 'desc' : 'asc';
      } else if (row.key === 'folderViews' && typeof entry.mode === 'string') {
        current.viewMode = entry.mode;
      }

      const updatedAt = Number(entry.updatedAt);
      if (Number.isFinite(updatedAt) && updatedAt > current.updatedAt) {
        current.updatedAt = updatedAt;
      }
      merged.set(key, current);
    }
  }

  if (merged.size === 0) return;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO folder_preferences
       (user_id, path, sort_by, sort_order, view_mode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const entry of merged.values()) {
    insert.run(
      entry.userId,
      entry.path,
      entry.sortBy,
      entry.sortOrder,
      entry.viewMode,
      new Date(entry.updatedAt || Date.now()).toISOString()
    );
  }

  db.prepare("DELETE FROM user_settings WHERE key IN ('folderSorts', 'folderViews')").run();
  logger.info({ count: merged.size }, '[DB Migration] Folder preferences moved to their own table');
};

const migrate = (db) => {
  // Simple schema versioning
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const getVersion = db.prepare('SELECT value FROM meta WHERE key = ?').pluck();
  let version = Number(getVersion.get('schema_version') || 0);

  db.transaction(() => {
    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_issuer, oidc_sub);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(1)
      );
      version = 1;
    }
    if (version < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_locks (
          key TEXT PRIMARY KEY, -- normalized username or subject key
          failed_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT
        );
      `);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(2)
      );
      version = 2;
    }
    if (version < 3) {
      logger.info('[DB Migration] Migrating to v3: Email-centric authentication...');

      // Create new tables
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          email_verified INTEGER DEFAULT 0,
          username TEXT,
          display_name TEXT,
          roles TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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
          FOREIGN KEY (user_id) REFERENCES users_new(id) ON DELETE CASCADE
        );
      `);

      // Migrate existing users
      const existingUsers = db.prepare('SELECT * FROM users').all();
      const preMigrationLocalCount = existingUsers.filter((u) => u.provider === 'local').length;
      const insertUser = db.prepare(`
        INSERT INTO users_new (id, email, email_verified, username, display_name, roles, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAuth = db.prepare(`
        INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo,
                                   provider_issuer, provider_sub, provider_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      logger.info({ userCount: existingUsers.length }, '[DB Migration] Migrating users...');

      for (const user of existingUsers) {
        // Generate email if missing (for old local users without email)
        const email = user.email || `${user.username || user.id}@example.local`;
        const emailVerified = user.email ? 1 : 0;

        // Insert user identity
        insertUser.run(
          user.id,
          email,
          emailVerified,
          user.username,
          user.display_name,
          user.roles,
          user.created_at,
          user.updated_at
        );

        // Insert auth method
        if (user.provider === 'local') {
          insertAuth.run(
            generateId(),
            user.id,
            'local_password',
            user.password_hash,
            user.password_algo || 'bcrypt',
            null,
            null,
            null,
            user.created_at
          );
        } else if (user.provider === 'oidc') {
          insertAuth.run(
            generateId(),
            user.id,
            'oidc',
            null,
            null,
            user.oidc_issuer,
            user.oidc_sub,
            'OIDC',
            user.created_at
          );
        }
      }

      // Replace old table with new one
      db.exec(`
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX idx_users_email ON users(email);
        CREATE INDEX idx_auth_methods_user ON auth_methods(user_id);
        CREATE UNIQUE INDEX idx_auth_methods_oidc ON auth_methods(provider_issuer, provider_sub) WHERE method_type = 'oidc';
        CREATE INDEX idx_auth_methods_type ON auth_methods(method_type);
      `);

      logger.info('[DB Migration] Migration to v3 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(3)
      );
      // Set a one-time announcement flag if there were any local users migrated
      try {
        if (preMigrationLocalCount > 0) {
          const notice = JSON.stringify({
            pending: true,
            localMigrated: preMigrationLocalCount,
            createdAt: new Date().toISOString(),
          });
          db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
            'notice_migration_v3',
            notice
          );
        }
      } catch (_) {
        // non-fatal
      }
      version = 3;
    }
    if (version < 4) {
      logger.info('[DB Migration] Migrating to v4: Adding favorites table...');

      db.exec(`
        CREATE TABLE favorites (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          path TEXT NOT NULL,
          label TEXT,
          icon TEXT DEFAULT '${DEFAULT_FAVORITE_ICON.replace(/'/g, "''")}',
          color TEXT DEFAULT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_favorites_user_path ON favorites(user_id, path);
        CREATE INDEX idx_favorites_user ON favorites(user_id);
      `);

      // Migrate existing favorites from app-config.json to SQLite
      migrateFavoritesFromJson(db);

      logger.info('[DB Migration] Migration to v4 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(4)
      );
      version = 4;
    }
    if (version < 5) {
      logger.info('[DB Migration] Migrating to v5: Adding shares functionality...');

      db.exec(`
        CREATE TABLE shares (
          id TEXT PRIMARY KEY,
          share_token TEXT UNIQUE NOT NULL,
          owner_id TEXT NOT NULL,
          source_space TEXT NOT NULL,
          source_path TEXT NOT NULL,
          is_directory INTEGER NOT NULL,
          access_mode TEXT NOT NULL CHECK(access_mode IN ('readonly', 'readwrite')),
          allow_delete INTEGER NOT NULL DEFAULT 1,
          allow_create_folder INTEGER NOT NULL DEFAULT 1,
          allow_create_file INTEGER NOT NULL DEFAULT 1,
          allow_upload INTEGER NOT NULL DEFAULT 1,
          allow_download INTEGER NOT NULL DEFAULT 1,
          sharing_type TEXT NOT NULL CHECK(sharing_type IN ('anyone', 'users')),
          password_hash TEXT,
          expires_at TEXT,
          label TEXT,
          access_count INTEGER DEFAULT 0,
          download_count INTEGER DEFAULT 0,
          last_accessed_at TEXT,
          last_access_ip TEXT,
          last_downloaded_at TEXT,
          last_download_ip TEXT,
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
      `);

      logger.info('[DB Migration] Migration to v5 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(5)
      );
      version = 5;
    }
    if (version < 6) {
      logger.info('[DB Migration] Migrating to v6: Adding user volumes functionality...');

      db.exec(`
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
      `);

      logger.info('[DB Migration] Migration to v6 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(6)
      );
      version = 6;
    }
    if (version < 8) {
      logger.info('[DB Migration] Migrating to v7: Adding settings tables...');

      db.exec(`
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
      `);

      // Migrate existing settings from JSON to database
      migrateSettingsFromJson(db);

      logger.info('[DB Migration] Migration to v7 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(8)
      );
      version = 8;
    }
    if (version < 9) {
      logger.info(
        '[DB Migration] Migrating to v9: Adding share audit counters and folder size index...'
      );

      addColumnIfMissing(db, 'shares', 'access_count', 'access_count INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'shares', 'last_access_ip', 'last_access_ip TEXT');
      addColumnIfMissing(db, 'shares', 'last_downloaded_at', 'last_downloaded_at TEXT');
      addColumnIfMissing(db, 'shares', 'last_download_ip', 'last_download_ip TEXT');
      db.prepare(
        `
        UPDATE shares
        SET access_count = COALESCE(download_count, 0),
            download_count = 0
        WHERE access_count IS NULL OR access_count = 0
      `
      ).run();

      // Pre-computed recursive folder sizes. Populated and kept up to date out
      // of band (baseline walk, incremental deltas, mtime reconciliation) so
      // that HTTP reads stay O(1) and never trigger a filesystem traversal.
      db.exec(FOLDER_SIZE_INDEX_DDL);

      logger.info('[DB Migration] Migration to v9 completed successfully!');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(9)
      );
      version = 9;
    }
    if (version < 10) {
      logger.info('[DB Migration] Migrating to v10: Adding granular share write permissions...');
      ensureShareOperationPermissionColumns(db);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(10)
      );
      version = 10;
    }
    if (version < 11) {
      logger.info('[DB Migration] Migrating to v11: Adding ONLYOFFICE document keys...');
      db.exec(ONLYOFFICE_DOCUMENT_KEYS_DDL);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(11)
      );
      version = 11;
    }
    if (version < 12) {
      logger.info('[DB Migration] Migrating to v12: Persisting ONLYOFFICE editing sessions...');
      db.exec(ONLYOFFICE_EDITOR_SESSIONS_DDL);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(12)
      );
      version = 12;
    }

    if (version < 13) {
      logger.info('[DB Migration] Migrating to v13: Remembering recent destinations...');
      db.exec(RECENT_DESTINATIONS_DDL);
      // eslint-disable-next-line global-require
      db.exec(require('./searchIndexStore').SEARCH_INDEX_DDL);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(13)
      );
      version = 13;
    }

    if (version < 14) {
      logger.info('[DB Migration] Migrating to v14: Per-folder preferences as rows...');
      db.exec(FOLDER_PREFERENCES_DDL);
      migrateFolderPreferencesFromUserSettings(db);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(14)
      );
      version = 14;
    }
    if (version < 15) {
      logger.info('[DB Migration] Migrating to v15: One personal folder per account...');
      addColumnIfMissing(db, 'users', 'personal_folder_name', 'personal_folder_name TEXT');
      // SQLite lets a unique index hold any number of NULLs, so an account that
      // has not claimed a name yet does not collide with the others.
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_personal_folder ON users(personal_folder_name);'
      );
      // eslint-disable-next-line global-require
      const { claimAllPersonalFolderNames } = require('./personalFolders');
      const claimed = claimAllPersonalFolderNames(db);
      logger.info({ claimed }, '[DB Migration] Personal folder names assigned');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(15)
      );
      version = 15;
    }
    if (version < 16) {
      logger.info('[DB Migration] Migrating to v16: Full-text search index...');
      // eslint-disable-next-line global-require
      db.exec(require('./searchIndexStore').SEARCH_INDEX_DDL);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(16)
      );
      version = 16;
    }

    if (version < 17) {
      logger.info('[DB Migration] Migrating to v17: search index by folder...');
      // Dropped rather than altered, and rebuilt from the files themselves.
      // The index is derived data — every row in it can be read again from the
      // disk it describes — so a migration that discards it costs one pass and
      // cannot leave a half-converted table behind.
      db.exec('DROP TABLE IF EXISTS search_terms');
      db.exec('DROP TABLE IF EXISTS search_documents');
      db.prepare('DELETE FROM meta WHERE key = ?').run('search_index_complete_at');
      // eslint-disable-next-line global-require
      db.exec(require('./searchIndexStore').SEARCH_INDEX_DDL);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(17)
      );
      version = 17;
    }
  })();

  // A shared /config directory may have its schema version advanced by another
  // image. Keep additive schema available in this mixed-version case.
  db.exec(FOLDER_SIZE_INDEX_DDL);
  db.exec(ONLYOFFICE_DOCUMENT_KEYS_DDL);
  db.exec(RECENT_DESTINATIONS_DDL);
  db.exec(FOLDER_PREFERENCES_DDL);
  db.exec(ONLYOFFICE_EDITOR_SESSIONS_DDL);
  ensureShareOperationPermissionColumns(db);
};

/**
 * Migrate settings from app-config.json to SQLite
 */
const migrateSettingsFromJson = (db) => {
  try {
    const jsonStoragePath = files.passwordConfig;

    // Check if app-config.json exists
    if (!fs.existsSync(jsonStoragePath)) {
      logger.debug('[DB Migration] No app-config.json found, skipping settings migration');
      return;
    }

    const configData = JSON.parse(fs.readFileSync(jsonStoragePath, 'utf8'));
    const oldSettings = configData.settings || {};

    if (!oldSettings || Object.keys(oldSettings).length === 0) {
      logger.debug('[DB Migration] No settings to migrate');
      return;
    }

    const insertSystemSetting = db.prepare(`
      INSERT OR REPLACE INTO system_settings (id, category, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    let migratedCount = 0;

    // Migrate branding settings
    if (oldSettings.branding) {
      try {
        insertSystemSetting.run(
          generateId(),
          'branding',
          'branding',
          JSON.stringify(oldSettings.branding),
          now
        );
        migratedCount++;
      } catch (err) {
        logger.warning({ err }, '[DB Migration] Error migrating branding');
      }
    }

    // Migrate thumbnail settings
    if (oldSettings.thumbnails) {
      try {
        insertSystemSetting.run(
          generateId(),
          'system',
          'thumbnails',
          JSON.stringify(oldSettings.thumbnails),
          now
        );
        migratedCount++;
      } catch (err) {
        logger.warning({ err }, '[DB Migration] Error migrating thumbnails');
      }
    }

    // Migrate access control rules
    if (oldSettings.access) {
      try {
        insertSystemSetting.run(
          generateId(),
          'system',
          'access',
          JSON.stringify(oldSettings.access),
          now
        );
        migratedCount++;
      } catch (err) {
        logger.warning({ err }, '[DB Migration] Error migrating access rules');
      }
    }

    logger.info({ migratedCount }, '[DB Migration] Migrated settings to database');
  } catch (err) {
    console.error('[DB Migration] Error migrating settings:', err);
    // Non-fatal, continue
  }
};

/**
 * Migrate favorites from app-config.json to SQLite
 */
const migrateFavoritesFromJson = (db) => {
  try {
    const jsonStoragePath = files.passwordConfig;

    // Check if app-config.json exists
    if (!fs.existsSync(jsonStoragePath)) {
      logger.debug('[DB Migration] No app-config.json found, skipping favorites migration');
      return;
    }

    const configData = JSON.parse(fs.readFileSync(jsonStoragePath, 'utf8'));
    const oldFavorites = configData.favorites || [];

    if (oldFavorites.length === 0) {
      logger.debug('[DB Migration] No favorites to migrate');
      return;
    }

    // Get all users from database
    const users = db.prepare('SELECT id FROM users').all();

    if (users.length === 0) {
      logger.debug('[DB Migration] No users found, skipping favorites migration');
      return;
    }

    // If there's only one user, assign all favorites to them
    // If multiple users, assign to the first user (admin)
    const targetUserId = users[0].id;

    const insertFavorite = db.prepare(`
      INSERT INTO favorites (id, user_id, path, label, icon, created_at, updated_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    let migratedCount = 0;

    for (const [index, fav] of oldFavorites.entries()) {
      if (!fav.path) continue;

      try {
        insertFavorite.run(
          generateId(),
          targetUserId,
          fav.path,
          fav.label || null, // Use existing label if present
          fav.icon || DEFAULT_FAVORITE_ICON,
          now,
          now,
          index
        );
        migratedCount++;
      } catch (err) {
        // Skip duplicates or invalid entries
        logger.debug({ err, favoritePath: fav.path }, '[DB Migration] Skipping favorite');
      }
    }

    logger.info({ migratedCount, targetUserId }, '[DB Migration] Migrated favorites to user');

    // Clear favorites from app-config.json
    configData.favorites = [];
    fs.writeFileSync(jsonStoragePath, JSON.stringify(configData, null, 2) + '\n', 'utf8');
    logger.info('[DB Migration] Cleared favorites from app-config.json');
  } catch (err) {
    console.error('[DB Migration] Error migrating favorites:', err);
    // Non-fatal, continue
  }
};

/**
 * Ensure the anonymous user exists in the database
 * This user is used when AUTH_ENABLED=false to provide user context for features like favorites
 */
const ensureAnonymousUser = (db) => {
  try {
    const { auth } = require('../config/index');

    // Only create anonymous user when auth is disabled
    if (auth.enabled !== false) {
      return;
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get('anonymous');

    if (!existingUser) {
      const now = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        'anonymous',
        'anonymous@local',
        1,
        'anonymous',
        'Anonymous User',
        '["admin"]',
        now,
        now
      );
      logger.info('[DB] Created anonymous user for AUTH_ENABLED=false mode');
    }
  } catch (err) {
    console.error('[DB] Error ensuring anonymous user:', err);
    // Non-fatal, continue
  }
};

/**
 * Prepared statements, compiled once per database handle.
 *
 * better-sqlite3 compiles on every prepare() call, and services that run per
 * item were compiling the same SQL thousands of times: a CPU profile of a
 * 3000-file delete put prepare() at the top of the applied work, ahead of the
 * filesystem calls it was meant to support.
 */
const statementCache = new WeakMap();

const prepared = (db, sql) => {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
};

const getDb = async () => {
  if (dbInstance) return dbInstance;

  const dbDir = directories.config;
  await ensureDir(dbDir);
  const dbPath = getDbPath();

  // Ensure file exists for clarity (better-sqlite3 will create if needed)
  try {
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, '');
    }
  } catch (_) {
    /* ignore */
  }

  const db = new Database(dbPath);
  // WAL lets the folder-size indexer worker thread write to the same database
  // file concurrently with the Express request threads reading from it.
  // busy_timeout makes the odd concurrent writer wait instead of throwing
  // SQLITE_BUSY. Both are safe no-ops if already applied.
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    logger.warn({ err }, '[DB] Failed to configure WAL/busy_timeout');
  }
  migrate(db);
  // Idempotently ensure feature tables exist regardless of the recorded
  // schema_version. A database created by another build that shares this
  // /config volume may already be past migration v9 without this table, which
  // would otherwise make the folder size indexer crash with "no such table".
  try {
    db.exec(FOLDER_SIZE_INDEX_DDL);
  } catch (err) {
    logger.warn({ err }, '[DB] Failed to ensure folder_size_index table');
  }
  ensureAnonymousUser(db);
  dbInstance = db;
  return dbInstance;
};

const closeDb = () => {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
};

module.exports = {
  getDb,
  prepared,
  closeDb,
};
