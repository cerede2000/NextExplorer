import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import {
  createLegacyDatabase,
  describeSchema,
  openDatabaseFile,
} from '../helpers/legacy-app-db.js';

/**
 * Upgrading the application database.
 *
 * Every installation runs these migrations the first time a new image starts
 * on its /config volume, and only that once. A step that is skipped, runs
 * twice, or stops half-way does not show up as a failing request: it shows up
 * as an installation that no longer starts, or that starts without the shares,
 * favorites and accounts it had yesterday. So each test here starts from a
 * database as a real release left it (see helpers/legacy-app-db.js), puts that
 * installation's rows in, opens it the way the application does, and reads the
 * rows back.
 */

const LATEST_SCHEMA_VERSION = '21';

let envContext;
let dbModule;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
  dbModule = null;
});

const prepareEnv = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'db-migrations-', env });
  return envContext;
};

/** Open the database the way the application does when it starts. */
const startApplication = async () => {
  dbModule = envContext.requireFresh('src/services/db');
  return dbModule.getDb();
};

/** Stop, then start again on the same file. */
const restartApplication = async () => {
  dbModule.closeDb();
  return startApplication();
};

const insert = (db, table, row) => {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => `@${key}`).join(', ')})`
  ).run(row);
};

const schemaVersion = (db) =>
  db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();

const tableNames = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());

const columnInfo = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all();

const columnNames = (db, table) => columnInfo(db, table).map((column) => column.name);

// `meta` is written with INSERT OR REPLACE, which moves a row to the end.
const rowsOf = (db, table, columns = ['*']) =>
  db
    .prepare(
      `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${table === 'meta' ? 'key' : 'rowid'}`
    )
    .all();

/** Every row of these tables, with the columns each table has now. */
const snapshot = (db, tables, { except = [] } = {}) =>
  Object.fromEntries(
    tables.map((table) => {
      const columns = columnNames(db, table).filter((name) => !except.includes(name));
      return [table, { columns, rows: rowsOf(db, table, columns) }];
    })
  );

const rowsNow = (db, before) =>
  Object.fromEntries(
    Object.entries(before).map(([table, { columns }]) => [table, rowsOf(db, table, columns)])
  );

const rowsThen = (before) =>
  Object.fromEntries(Object.entries(before).map(([table, { rows }]) => [table, rows]));

const share = (db, id) => db.prepare('SELECT * FROM shares WHERE id = ?').get(id);

const T = '2025-09-01T08:00:00.000Z';

/**
 * Every table the application reads or writes in app.db, found by listing the
 * tables named in the SQL under src/. `sessions` is not among them: the session
 * store creates it itself, in its own file.
 */
const APPLICATION_TABLES = [
  'meta',
  'users',
  'auth_methods',
  'auth_locks',
  'favorites',
  'shares',
  'share_permissions',
  'guest_sessions',
  'user_volumes',
  'system_settings',
  'user_settings',
  'onlyoffice_document_keys',
  'onlyoffice_editor_sessions',
  'recent_destinations',
  'folder_preferences',
  'trash_zones',
  'trash_items',
  'trash_shares',
  'trash_events',
  'version_files',
  'file_versions',
  'personal_folder_reservations',
  'totp_credentials',
  'totp_recovery_codes',
];

/** The indexes, in their own database under the cache directory. */
const INDEX_TABLES = ['folder_size_index', 'search_documents', 'search_terms'];

const openIndex = () => envContext.requireFresh('src/services/indexDb').getIndexDb();

describe('a new installation', () => {
  it('comes up at the latest version with every table the application uses', async () => {
    await prepareEnv();
    const db = await startApplication();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = tableNames(db);
    for (const table of APPLICATION_TABLES) {
      expect(tables.has(table), `table ${table}`).toBe(true);
    }
    const index = await openIndex();
    for (const table of INDEX_TABLES) {
      expect(tables.has(table), `${table} left in app.db`).toBe(false);
      expect(tableNames(index).has(table), `${table} in index.db`).toBe(true);
    }
    expect(columnNames(db, 'users')).toContain('personal_folder_name');
    expect(columnNames(db, 'trash_items')).toContain('restore_entry');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").pluck().all()
    ).toContain('trash_items_take_versions');
  });

  it('keeps nothing of the steps it went through', async () => {
    await prepareEnv();
    const db = await startApplication();

    expect(tableNames(db).has('users_new')).toBe(false);
    expect(db.prepare('SELECT key FROM meta ORDER BY key').pluck().all()).toEqual([
      'schema_version',
    ]);
  });

  // A share handed out after the upgrade shows no history until its owner says
  // so; downloads stay allowed, as they always were.
  it('gives a new share no file history, and downloads, unless its owner decides otherwise', async () => {
    await prepareEnv();
    const db = await startApplication();

    const columns = Object.fromEntries(columnInfo(db, 'shares').map((c) => [c.name, c]));
    expect(columns.versions_visible).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(columns.versions_download).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(columns.allow_download).toMatchObject({ notnull: 1, dflt_value: '1' });
  });

  it('creates no account while authentication is on', async () => {
    await prepareEnv();
    const db = await startApplication();

    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0);
  });

  it('creates one anonymous administrator when authentication is off, and only one', async () => {
    await prepareEnv({ AUTH_ENABLED: 'false' });
    await startApplication();
    const db = await restartApplication();

    expect(db.prepare('SELECT id, username, roles FROM users').all()).toEqual([
      { id: 'anonymous', username: 'anonymous', roles: '["admin"]' },
    ]);
  });
});

/** Upstream 2.2.7, the last upstream release, records schema 8. */
const seedRelease227 = (db) => {
  insert(db, 'users', {
    id: 'admin-1',
    email: 'admin@example.com',
    email_verified: 1,
    username: 'admin',
    display_name: 'Admin',
    roles: '["admin"]',
    created_at: '2025-01-10T09:00:00.000Z',
    updated_at: '2025-06-01T09:00:00.000Z',
  });
  insert(db, 'users', {
    id: 'alice-2',
    email: 'alice@example.com',
    email_verified: 1,
    username: 'alice',
    display_name: 'Alice',
    roles: '["user"]',
    created_at: '2025-02-10T09:00:00.000Z',
    updated_at: '2025-02-10T09:00:00.000Z',
  });
  insert(db, 'auth_methods', {
    id: 'am-1',
    user_id: 'admin-1',
    method_type: 'local_password',
    password_hash: '$2b$10$adminhash',
    password_algo: 'bcrypt',
    last_used_at: T,
    created_at: '2025-01-10T09:00:00.000Z',
  });
  insert(db, 'auth_methods', {
    id: 'am-2',
    user_id: 'alice-2',
    method_type: 'oidc',
    provider_issuer: 'https://id.example.com',
    provider_sub: 'sub-alice',
    provider_name: 'OIDC',
    created_at: '2025-02-10T09:00:00.000Z',
  });
  insert(db, 'auth_locks', { key: 'alice', failed_count: 2, locked_until: null });
  insert(db, 'favorites', {
    id: 'fav-1',
    user_id: 'admin-1',
    path: 'Projects',
    label: 'Projets',
    icon: 'outline:FolderIcon',
    color: '#d97706',
    position: 0,
    created_at: T,
    updated_at: T,
  });
  insert(db, 'favorites', {
    id: 'fav-2',
    user_id: 'alice-2',
    path: 'personal/Photos',
    position: 0,
    created_at: T,
    updated_at: T,
  });
  // A link for anyone, visited five times: before schema 9 the visits were
  // counted in download_count.
  insert(db, 'shares', {
    id: 'share-link',
    share_token: 'tok-link',
    owner_id: 'admin-1',
    source_space: 'volume',
    source_path: 'Projects/brochure.pdf',
    is_directory: 0,
    access_mode: 'readonly',
    sharing_type: 'anyone',
    label: 'Brochure',
    download_count: 5,
    last_accessed_at: T,
    created_at: T,
    updated_at: T,
  });
  insert(db, 'shares', {
    id: 'share-team',
    share_token: 'tok-team',
    owner_id: 'admin-1',
    source_space: 'volume',
    source_path: 'Projects',
    is_directory: 1,
    access_mode: 'readwrite',
    sharing_type: 'users',
    password_hash: '$2b$10$sharehash',
    expires_at: '2027-01-01T00:00:00.000Z',
    label: 'Team',
    download_count: 2,
    created_at: T,
    updated_at: T,
  });
  insert(db, 'share_permissions', {
    id: 'sp-1',
    share_id: 'share-team',
    user_id: 'alice-2',
    created_at: T,
  });
  insert(db, 'guest_sessions', {
    id: 'gs-1',
    share_id: 'share-link',
    ip_address: '203.0.113.7',
    user_agent: 'Mozilla/5.0',
    created_at: T,
    expires_at: '2027-01-01T00:00:00.000Z',
    last_activity_at: T,
  });
  insert(db, 'user_volumes', {
    id: 'uv-1',
    user_id: 'alice-2',
    label: 'Archive',
    path: '/mnt/archive',
    access_mode: 'readonly',
    created_at: T,
    updated_at: T,
  });
  insert(db, 'system_settings', {
    id: 'ss-1',
    category: 'branding',
    key: 'branding',
    value: '{"appName":"Team Files"}',
    updated_at: T,
  });
  insert(db, 'system_settings', {
    id: 'ss-2',
    category: 'system',
    key: 'thumbnails',
    value: '{"enabled":true,"size":300,"quality":80}',
    updated_at: T,
  });
  insert(db, 'user_settings', {
    id: 'us-1',
    user_id: 'alice-2',
    key: 'theme',
    value: '"dark"',
    updated_at: T,
  });
  insert(db, 'meta', { key: 'notice_migration_v3', value: '{"pending":false,"localMigrated":1}' });
};

const TABLES_OF_RELEASE_227 = [
  'users',
  'auth_methods',
  'auth_locks',
  'favorites',
  'shares',
  'share_permissions',
  'guest_sessions',
  'user_volumes',
  'system_settings',
  'user_settings',
  'meta',
];

describe('an installation left by upstream 2.2.7 (schema 8)', () => {
  const upgrade = async (env) => {
    const { configDir } = await prepareEnv(env);
    const legacy = createLegacyDatabase(configDir, 8);
    seedRelease227(legacy);
    // The visit counter moves on the way; everything else must not.
    const before = snapshot(legacy, TABLES_OF_RELEASE_227, { except: ['download_count'] });
    legacy.close();
    const db = await startApplication();
    return { db, before };
  };

  it('reaches the latest version with every account, sign-in, favorite, share, volume and setting as it was', async () => {
    const { db, before } = await upgrade();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const expected = rowsThen(before);
    expected.meta = expected.meta.map((row) =>
      row.key === 'schema_version' ? { ...row, value: LATEST_SCHEMA_VERSION } : row
    );
    expect(rowsNow(db, before)).toEqual(expected);
  });

  it('counts the visits the old counter recorded as visits, not as downloads', async () => {
    const { db } = await upgrade();

    expect(share(db, 'share-link')).toMatchObject({ access_count: 5, download_count: 0 });
    expect(share(db, 'share-team')).toMatchObject({ access_count: 2, download_count: 0 });
  });

  it('lets every existing share go on doing what it did', async () => {
    const { db } = await upgrade();

    for (const id of ['share-link', 'share-team']) {
      expect(share(db, id)).toMatchObject({
        allow_delete: 1,
        allow_create_folder: 1,
        allow_create_file: 1,
        allow_upload: 1,
        allow_download: 1,
      });
    }
  });

  it('shows file history to the people a share names, and not to anyone holding a link', async () => {
    const { db } = await upgrade();

    expect(share(db, 'share-team')).toMatchObject({ versions_visible: 1, versions_download: 1 });
    expect(share(db, 'share-link')).toMatchObject({ versions_visible: 0, versions_download: 0 });
  });

  it('gives each account a personal folder name of its own', async () => {
    const { db } = await upgrade();

    expect(db.prepare('SELECT id, personal_folder_name FROM users ORDER BY id').all()).toEqual([
      { id: 'admin-1', personal_folder_name: 'admin-1' },
      { id: 'alice-2', personal_folder_name: 'alice-2' },
    ]);
  });

  it('adds the tables of every later feature, empty', async () => {
    const { db } = await upgrade();

    for (const table of [
      'onlyoffice_document_keys',
      'onlyoffice_editor_sessions',
      'recent_destinations',
      'folder_preferences',
      'trash_zones',
      'trash_items',
      'trash_shares',
      'trash_events',
      'version_files',
      'file_versions',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
    }
  });
});

/** 3.0.0 records schema 13: share permissions, but no allow_download yet. */
const seedRelease300 = (db) => {
  // Two accounts whose usernames collide; the older one has been using the
  // folder the name points at.
  insert(db, 'users', {
    id: 'u-new',
    email: 'bob@b.example',
    username: 'bob',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  });
  insert(db, 'users', {
    id: 'u-old',
    email: 'bob@a.example',
    username: 'bob',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });
  insert(db, 'shares', {
    id: 'share-team',
    share_token: 'tok-team',
    owner_id: 'u-old',
    source_space: 'volume',
    source_path: 'Projects',
    is_directory: 1,
    access_mode: 'readwrite',
    allow_delete: 0,
    allow_create_folder: 1,
    allow_create_file: 1,
    allow_upload: 0,
    sharing_type: 'users',
    access_count: 7,
    download_count: 3,
    last_access_ip: '198.51.100.4',
    last_downloaded_at: T,
    last_download_ip: '198.51.100.4',
    created_at: T,
    updated_at: T,
  });
  insert(db, 'folder_size_index', {
    path_hash: 'hash-projects',
    volume: 'volume',
    relative_path: 'Projects',
    size_bytes: 1048576,
    entry_count: 12,
    last_full_scan_at: T,
  });
  insert(db, 'onlyoffice_document_keys', {
    relative_path: 'Projects/plan.docx',
    document_key: 'key-1',
    signature: 'sig-1',
    created_at: T,
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  insert(db, 'recent_destinations', { user_id: 'u-old', path: 'Projects', used_at: T });
};

describe('an installation left by 3.0.0 (schema 13)', () => {
  const upgrade = async () => {
    const { configDir } = await prepareEnv({ USER_FOLDER_NAME_ORDER: 'username,id' });
    const legacy = createLegacyDatabase(configDir, 13);
    seedRelease300(legacy);
    const before = snapshot(legacy, ['onlyoffice_document_keys', 'recent_destinations']);
    legacy.close();
    const db = await startApplication();
    return { db, before };
  };

  // Its schema version is already past the step that added share permissions,
  // so only the check that runs on every start can add the column.
  it('adds the download permission 3.0.0 lacked, allowed, and keeps what an owner had narrowed', async () => {
    const { db } = await upgrade();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(share(db, 'share-team')).toMatchObject({
      allow_download: 1,
      allow_delete: 0,
      allow_upload: 0,
      allow_create_folder: 1,
      allow_create_file: 1,
    });
  });

  it('leaves the visit and download counters as they were', async () => {
    const { db } = await upgrade();

    expect(share(db, 'share-team')).toMatchObject({
      access_count: 7,
      download_count: 3,
      last_access_ip: '198.51.100.4',
      last_download_ip: '198.51.100.4',
    });
  });

  it('keeps the folder sizes, editor keys and recent destinations it had', async () => {
    const { db, before } = await upgrade();

    expect(rowsNow(db, before)).toEqual(rowsThen(before));
  });

  it('gives a contested personal folder name to the account that has had it longest', async () => {
    const { db } = await upgrade();

    expect(db.prepare('SELECT id, personal_folder_name FROM users ORDER BY id').all()).toEqual([
      { id: 'u-new', personal_folder_name: 'u-new' },
      { id: 'u-old', personal_folder_name: 'bob' },
    ]);
  });

  it('carries its folder sizes into the index database, as they were', async () => {
    const { db } = await upgrade();
    const index = await openIndex();

    expect(tableNames(db).has('folder_size_index')).toBe(false);
    expect(
      index
        .prepare('SELECT path_hash, relative_path, size_bytes, entry_count FROM folder_size_index')
        .all()
    ).toEqual([
      {
        path_hash: 'hash-projects',
        relative_path: 'Projects',
        size_bytes: 1048576,
        entry_count: 12,
      },
    ]);
  });

  it('builds an empty search index by folder, not yet marked complete', async () => {
    await upgrade();
    const index = await openIndex();

    expect(columnNames(index, 'search_documents')).toContain('dir');
    expect(index.prepare('SELECT COUNT(*) FROM search_documents').pluck().get()).toBe(0);
    expect(
      index.prepare("SELECT value FROM meta WHERE key = 'search_index_complete_at'").get()
    ).toBeUndefined();
  });
});

/** 3.5.0, the last release, records schema 17. */
const seedRelease350 = (db) => {
  insert(db, 'users', {
    id: 'admin-1',
    email: 'admin@example.com',
    email_verified: 1,
    username: 'admin',
    roles: '["admin"]',
    created_at: '2025-01-10T09:00:00.000Z',
    updated_at: '2025-01-10T09:00:00.000Z',
    personal_folder_name: 'admin-1',
  });
  insert(db, 'users', {
    id: 'alice-2',
    email: 'alice@example.com',
    email_verified: 1,
    username: 'alice',
    roles: '["user"]',
    created_at: '2025-02-10T09:00:00.000Z',
    updated_at: '2025-02-10T09:00:00.000Z',
    personal_folder_name: 'alice',
  });
  insert(db, 'favorites', {
    id: 'fav-1',
    user_id: 'alice-2',
    path: 'personal/Photos',
    position: 0,
    created_at: T,
    updated_at: T,
  });
  // A link whose owner withheld downloads, and a share with a named account.
  insert(db, 'shares', {
    id: 'share-link',
    share_token: 'tok-link',
    owner_id: 'admin-1',
    source_space: 'volume',
    source_path: 'Projects/brochure.pdf',
    is_directory: 0,
    access_mode: 'readonly',
    allow_download: 0,
    sharing_type: 'anyone',
    access_count: 12,
    created_at: T,
    updated_at: T,
  });
  insert(db, 'shares', {
    id: 'share-team',
    share_token: 'tok-team',
    owner_id: 'admin-1',
    source_space: 'volume',
    source_path: 'Projects',
    is_directory: 1,
    access_mode: 'readwrite',
    allow_delete: 0,
    sharing_type: 'users',
    created_at: T,
    updated_at: T,
  });
  insert(db, 'share_permissions', {
    id: 'sp-1',
    share_id: 'share-team',
    user_id: 'alice-2',
    created_at: T,
  });
  insert(db, 'folder_preferences', {
    user_id: 'alice-2',
    path: 'personal/Photos',
    sort_by: 'name',
    sort_order: 'desc',
    view_mode: 'grid',
    updated_at: T,
  });
  insert(db, 'search_documents', {
    id: 1,
    path: 'Projects/brochure.pdf',
    dir: 'Projects',
    mtime_ms: 1700000000000,
    size: 2048,
    indexed_at: T,
  });
  db.prepare('INSERT INTO search_terms (rowid, text) VALUES (?, ?)').run(1, 'brochure printemps');
  insert(db, 'meta', { key: 'search_index_complete_at', value: T });
};

const TABLES_OF_RELEASE_350 = [
  'users',
  'favorites',
  'shares',
  'share_permissions',
  'folder_preferences',
];

describe('an installation left by 3.5.0 (schema 17), the last release', () => {
  const upgrade = async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 17);
    seedRelease350(legacy);
    const before = snapshot(legacy, TABLES_OF_RELEASE_350);
    legacy.close();
    const db = await startApplication();
    return { db, before };
  };

  it('reaches the latest version with every row it had', async () => {
    const { db, before } = await upgrade();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(rowsNow(db, before)).toEqual(rowsThen(before));
  });

  // The index is derived data, but rebuilding it is a pass over every volume:
  // the step that throws it away must not run on a database already past it,
  // and moving it out of app.db must carry it as it was.
  it('carries its search index and the record that it is complete into the index database', async () => {
    const { db } = await upgrade();
    const index = await openIndex();

    expect(tableNames(db).has('search_documents')).toBe(false);
    expect(
      index
        .prepare("SELECT rowid FROM search_terms WHERE search_terms MATCH 'brochure'")
        .pluck()
        .all()
    ).toEqual([1]);
    expect(index.prepare('SELECT path FROM search_documents').pluck().all()).toEqual([
      'Projects/brochure.pdf',
    ]);
    expect(
      index.prepare("SELECT value FROM meta WHERE key = 'search_index_complete_at'").pluck().get()
    ).toBe(T);
    expect(
      db.prepare("SELECT value FROM meta WHERE key = 'search_index_complete_at'").pluck().get()
    ).toBeUndefined();
  });

  it('shows file history to the people a share names, and not to anyone holding a link', async () => {
    const { db } = await upgrade();

    expect(share(db, 'share-team')).toMatchObject({ versions_visible: 1, versions_download: 1 });
    expect(share(db, 'share-link')).toMatchObject({ versions_visible: 0, versions_download: 0 });
  });

  it('keeps the permissions an owner had set on a share', async () => {
    const { db } = await upgrade();

    expect(share(db, 'share-link')).toMatchObject({ allow_download: 0, access_count: 12 });
    expect(share(db, 'share-team')).toMatchObject({ allow_delete: 0, allow_download: 1 });
  });

  it('adds the trash and the file history, tied so a trash item that goes takes its histories', async () => {
    const { db } = await upgrade();

    insert(db, 'trash_items', {
      id: 'item-1',
      zone_id: 'zone-1',
      state: 'trashed',
      name: 'plan.docx',
      kind: 'file',
      original_path: '/volume/Projects/plan.docx',
      relative_path: 'items/item-1',
      deleted_at: T,
      updated_at: T,
    });
    insert(db, 'version_files', {
      id: 'vf-1',
      zone_id: 'zone-1',
      relative_path: 'Projects/plan.docx',
      state: 'trashed',
      trash_item_id: 'item-1',
      created_at: T,
      updated_at: T,
    });
    db.prepare('DELETE FROM trash_items WHERE id = ?').run('item-1');

    expect(
      db.prepare('SELECT state, trash_item_id FROM version_files WHERE id = ?').get('vf-1')
    ).toEqual({ state: 'purging', trash_item_id: null });
    expect(columnNames(db, 'trash_items')).toContain('restore_entry');
    expect(tableNames(db).has('file_versions')).toBe(true);
  });
});

describe('the next start', () => {
  // An owner who hid a share's history after the upgrade must find it hidden
  // after every restart: the switch-on belongs to the moment the column
  // appears, not to every start.
  it('changes nothing on a database that is already current', async () => {
    await prepareEnv();
    const db = await startApplication();
    insert(db, 'users', {
      id: 'admin-1',
      email: 'admin@example.com',
      created_at: T,
      updated_at: T,
    });
    insert(db, 'shares', {
      id: 'share-team',
      share_token: 'tok-team',
      owner_id: 'admin-1',
      source_space: 'volume',
      source_path: 'Projects',
      is_directory: 1,
      access_mode: 'readonly',
      sharing_type: 'users',
      versions_visible: 0,
      versions_download: 0,
      created_at: T,
      updated_at: T,
    });
    insert(db, 'shares', {
      id: 'share-link',
      share_token: 'tok-link',
      owner_id: 'admin-1',
      source_space: 'volume',
      source_path: 'Projects/brochure.pdf',
      is_directory: 0,
      access_mode: 'readonly',
      sharing_type: 'anyone',
      versions_visible: 1,
      versions_download: 0,
      created_at: T,
      updated_at: T,
    });
    const schemaBefore = describeSchema(db);
    const before = snapshot(db, ['meta', 'users', 'shares']);

    const reopened = await restartApplication();

    expect(describeSchema(reopened)).toEqual(schemaBefore);
    expect(rowsNow(reopened, before)).toEqual(rowsThen(before));
  });

  it('leaves an upgraded installation exactly as the upgrade left it', async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 8);
    seedRelease227(legacy);
    legacy.close();
    const db = await startApplication();
    // Activity after the upgrade, which a second pass must not disturb.
    db.prepare('UPDATE shares SET download_count = 4 WHERE id = ?').run('share-link');
    const schemaBefore = describeSchema(db);
    const before = snapshot(db, TABLES_OF_RELEASE_227);

    const reopened = await restartApplication();

    expect(describeSchema(reopened)).toEqual(schemaBefore);
    expect(rowsNow(reopened, before)).toEqual(rowsThen(before));
  });
});

/**
 * All the steps an upgrade needs run in one transaction. The failure injected
 * here comes after the step that converts per-folder preferences — which deletes
 * the rows it converts — so a partial commit would leave a database that no
 * version recognises.
 */
describe('an upgrade that fails part-way', () => {
  const failingUpgrade = async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 13);
    insert(legacy, 'users', {
      id: 'u-1',
      email: 'bob@example.com',
      username: 'bob',
      created_at: T,
      updated_at: T,
    });
    insert(legacy, 'user_settings', {
      id: 'us-sorts',
      user_id: 'u-1',
      key: 'folderSorts',
      value: JSON.stringify({ Projects: { by: 'size', order: 'desc', updatedAt: 1756300000000 } }),
      updated_at: T,
    });
    insert(legacy, 'user_settings', {
      id: 'us-theme',
      user_id: 'u-1',
      key: 'theme',
      value: '"dark"',
      updated_at: T,
    });
    const before = snapshot(legacy, ['users', 'user_settings', 'meta']);
    const schemaBefore = describeSchema(legacy);
    legacy.close();

    const personalFolders = envContext.requireFresh('src/services/personalFolders');
    const failure = vi
      .spyOn(personalFolders, 'claimAllPersonalFolderNames')
      .mockImplementation(() => {
        throw new Error('disk I/O error');
      });

    await expect(startApplication()).rejects.toThrow('disk I/O error');
    return { configDir, before, schemaBefore, failure };
  };

  it('refuses to start and leaves the previous version, schema and rows as they were', async () => {
    const { configDir, before, schemaBefore, failure } = await failingUpgrade();

    expect(failure).toHaveBeenCalled();
    const db = openDatabaseFile(configDir);
    try {
      expect(schemaVersion(db)).toBe('13');
      expect(describeSchema(db)).toEqual(schemaBefore);
      expect(rowsNow(db, before)).toEqual(rowsThen(before));
    } finally {
      db.close();
    }
  });

  it('completes the upgrade at the next start once the cause is gone', async () => {
    await failingUpgrade();
    vi.restoreAllMocks();

    const db = await startApplication();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db.prepare('SELECT user_id, path, sort_by, sort_order FROM folder_preferences').all()
    ).toEqual([{ user_id: 'u-1', path: 'Projects', sort_by: 'size', sort_order: 'desc' }]);
    expect(db.prepare('SELECT key FROM user_settings').pluck().all()).toEqual(['theme']);
    expect(db.prepare('SELECT personal_folder_name FROM users').pluck().get()).toBe('u-1');
  });
});

/**
 * /config can be shared with another image, which may already have recorded a
 * later schema version without creating what this build needs. The additive
 * part of the schema is therefore ensured on every start, whatever the version.
 */
describe('a database whose recorded version is ahead of its tables', () => {
  it('creates the trash and the file history even when their version is already recorded', async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 17);
    seedRelease350(legacy);
    legacy
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(LATEST_SCHEMA_VERSION, 'schema_version');
    legacy.close();

    const db = await startApplication();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    for (const table of [
      'trash_items',
      'trash_shares',
      'version_files',
      'file_versions',
      'totp_credentials',
      'totp_recovery_codes',
    ]) {
      expect(tableNames(db).has(table), table).toBe(true);
    }
    expect(share(db, 'share-team')).toMatchObject({ versions_visible: 1, versions_download: 1 });
    expect(share(db, 'share-link')).toMatchObject({ versions_visible: 0, versions_download: 0 });
  });

  // The trash first shipped without the column a restore of one entry of a
  // deleted folder records, and with an item possibly mid-restore.
  it('adds the restore column to a trash kept before it existed, keeping its items', async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 18);
    insert(legacy, 'trash_zones', { id: 'zone-1', root: '/volume', created_at: T });
    insert(legacy, 'trash_items', {
      id: 'item-1',
      zone_id: 'zone-1',
      state: 'restoring',
      name: 'Projects',
      kind: 'directory',
      size_bytes: 4096,
      original_path: '/volume/Projects',
      relative_path: 'items/item-1',
      restore_path: '/volume/Projects',
      deleted_at: T,
      updated_at: T,
    });
    const before = snapshot(legacy, ['trash_zones', 'trash_items']);
    legacy.close();

    const db = await startApplication();

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(columnNames(db, 'trash_items')).toContain('restore_entry');
    expect(rowsNow(db, before)).toEqual(rowsThen(before));
    expect(db.prepare('SELECT restore_entry FROM trash_items').pluck().get()).toBeNull();
    expect(tableNames(db).has('trash_shares')).toBe(true);
  });

  it('leaves the version a newer build recorded where it was', async () => {
    const { configDir } = await prepareEnv();
    await startApplication();
    dbModule.closeDb();
    const raw = openDatabaseFile(configDir);
    raw.prepare("UPDATE meta SET value = '25' WHERE key = 'schema_version'").run();
    raw.close();

    const db = await startApplication();

    expect(schemaVersion(db)).toBe('25');
  });
});
