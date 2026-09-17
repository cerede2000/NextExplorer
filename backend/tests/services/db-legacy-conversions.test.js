import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import { createLegacyDatabase } from '../helpers/legacy-app-db.js';

/**
 * The migrations that convert data rather than add to it.
 *
 * Adding a table or a column cannot lose anything. These steps can: they read
 * accounts, favorites, settings and preferences out of the shape an older
 * version kept them in, write them into a new one, and in several cases delete
 * the old copy. A mistake there is silent — the application starts, and the
 * favorites or the sign-in method are simply gone — so each test starts from the
 * legacy shape the step exists for and reads the converted rows back.
 */

let envContext;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const prepareEnv = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'db-legacy-', env });
  return envContext;
};

const startApplication = () => envContext.requireFresh('src/services/db').getDb();

const insert = (db, table, row) => {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => `@${key}`).join(', ')})`
  ).run(row);
};

const schemaVersion = (db) =>
  db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();

const appConfigPath = () => path.join(envContext.configDir, 'app-config.json');

const writeAppConfig = (data) =>
  fs.writeFileSync(appConfigPath(), `${JSON.stringify(data, null, 2)}\n`, 'utf8');

const readAppConfig = () => JSON.parse(fs.readFileSync(appConfigPath(), 'utf8'));

const T = '2024-01-01T00:00:00.000Z';

/**
 * Schema 2 kept the sign-in method in the account row; schema 3 split accounts
 * from the ways to sign in to them, and made the email the identity.
 */
describe('accounts from before sign-in methods had a table of their own (schema 2)', () => {
  const V2_ACCOUNTS = [
    {
      id: 'u-admin',
      provider: 'local',
      username: 'admin',
      password_hash: '$2b$10$adminhash',
      password_algo: 'bcrypt',
      display_name: 'Admin',
      email: 'admin@example.com',
      roles: '["admin"]',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-05T00:00:00.000Z',
    },
    // A local account from before emails were asked for, whose algorithm was
    // never written down.
    {
      id: 'u-bob',
      provider: 'local',
      username: 'bob',
      password_hash: '$2b$10$bobhash',
      password_algo: null,
      display_name: 'Bob',
      email: null,
      roles: '["user"]',
      created_at: '2024-02-01T00:00:00.000Z',
      updated_at: '2024-02-01T00:00:00.000Z',
    },
    {
      id: 'u-nameless',
      provider: 'local',
      username: null,
      password_hash: '$2b$10$namelesshash',
      password_algo: 'bcrypt',
      display_name: null,
      email: null,
      roles: '["user"]',
      created_at: '2024-02-02T00:00:00.000Z',
      updated_at: '2024-02-02T00:00:00.000Z',
    },
    {
      id: 'u-carol',
      provider: 'oidc',
      username: 'carol',
      oidc_issuer: 'https://id.example.com',
      oidc_sub: 'sub-carol',
      display_name: 'Carol',
      email: 'carol@example.com',
      roles: '["user"]',
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
    },
  ];

  const upgrade = async (accounts = V2_ACCOUNTS) => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 2);
    accounts.forEach((account) => insert(legacy, 'users', account));
    insert(legacy, 'auth_locks', {
      key: 'bob',
      failed_count: 3,
      locked_until: '2024-03-01T00:00:00.000Z',
    });
    legacy.close();
    return startApplication();
  };

  const method = (db, userId) =>
    db
      .prepare(
        `SELECT method_type, password_hash, password_algo, provider_issuer, provider_sub,
                provider_name, enabled, created_at
           FROM auth_methods WHERE user_id = ?`
      )
      .all(userId);

  it('keeps every account under its id, with its email or a placeholder not marked verified', async () => {
    const db = await upgrade();

    expect(schemaVersion(db)).toBe('22');
    expect(
      db
        .prepare(
          `SELECT id, email, email_verified, username, display_name, roles, created_at, updated_at
             FROM users ORDER BY created_at`
        )
        .all()
    ).toEqual([
      {
        id: 'u-admin',
        email: 'admin@example.com',
        email_verified: 1,
        username: 'admin',
        display_name: 'Admin',
        roles: '["admin"]',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-05T00:00:00.000Z',
      },
      {
        id: 'u-bob',
        email: 'bob@example.local',
        email_verified: 0,
        username: 'bob',
        display_name: 'Bob',
        roles: '["user"]',
        created_at: '2024-02-01T00:00:00.000Z',
        updated_at: '2024-02-01T00:00:00.000Z',
      },
      {
        id: 'u-nameless',
        email: 'u-nameless@example.local',
        email_verified: 0,
        username: null,
        display_name: null,
        roles: '["user"]',
        created_at: '2024-02-02T00:00:00.000Z',
        updated_at: '2024-02-02T00:00:00.000Z',
      },
      {
        id: 'u-carol',
        email: 'carol@example.com',
        email_verified: 1,
        username: 'carol',
        display_name: 'Carol',
        roles: '["user"]',
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-01T00:00:00.000Z',
      },
    ]);
  });

  it('turns a local password into a sign-in method, as bcrypt when no algorithm was recorded', async () => {
    const db = await upgrade();

    expect(method(db, 'u-admin')).toEqual([
      {
        method_type: 'local_password',
        password_hash: '$2b$10$adminhash',
        password_algo: 'bcrypt',
        provider_issuer: null,
        provider_sub: null,
        provider_name: null,
        enabled: 1,
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ]);
    expect(method(db, 'u-bob')).toMatchObject([
      { method_type: 'local_password', password_hash: '$2b$10$bobhash', password_algo: 'bcrypt' },
    ]);
  });

  it('turns a single sign-on account into a sign-in method with its issuer and subject', async () => {
    const db = await upgrade();

    expect(method(db, 'u-carol')).toEqual([
      {
        method_type: 'oidc',
        password_hash: null,
        password_algo: null,
        provider_issuer: 'https://id.example.com',
        provider_sub: 'sub-carol',
        provider_name: 'OIDC',
        enabled: 1,
        created_at: '2024-03-01T00:00:00.000Z',
      },
    ]);
  });

  it('leaves nothing of the old table, and keeps the sign-in locks', async () => {
    const db = await upgrade();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).not.toContain('users_new');
    expect(
      db
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((c) => c.name)
    ).not.toContain('provider');
    expect(db.prepare('SELECT * FROM auth_locks').all()).toEqual([
      { key: 'bob', failed_count: 3, locked_until: '2024-03-01T00:00:00.000Z' },
    ]);
  });

  it('leaves a one-time notice counting the local accounts it converted', async () => {
    const db = await upgrade();

    const notice = JSON.parse(
      db.prepare("SELECT value FROM meta WHERE key = 'notice_migration_v3'").pluck().get()
    );
    expect(notice).toMatchObject({ pending: true, localMigrated: 3 });
  });

  it('leaves no notice when there were only single sign-on accounts', async () => {
    const db = await upgrade(V2_ACCOUNTS.filter((account) => account.provider === 'oidc'));

    expect(
      db.prepare("SELECT value FROM meta WHERE key = 'notice_migration_v3'").get()
    ).toBeUndefined();
  });
});

/** Up to 1.2.0 (schema 3), favorites lived in app-config.json. */
describe('favorites kept in app-config.json (schema 3)', () => {
  const APP_CONFIG = {
    version: 4,
    settings: { thumbnails: { enabled: true, size: 200, quality: 70 }, access: { rules: [] } },
    favorites: [
      { path: 'Projects', icon: 'solid:StarIcon' },
      { path: 'Photos/2024', label: 'Photos' },
      { icon: 'solid:StarIcon' },
      { path: 'Projects', icon: 'solid:HeartIcon' },
    ],
  };

  const upgrade = async ({ accounts = true, appConfig = APP_CONFIG } = {}) => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 3);
    if (accounts) {
      insert(legacy, 'users', {
        id: 'u-admin',
        email: 'admin@example.com',
        created_at: T,
        updated_at: T,
      });
      insert(legacy, 'users', {
        id: 'u-alice',
        email: 'alice@example.com',
        created_at: T,
        updated_at: T,
      });
    }
    legacy.close();
    if (typeof appConfig === 'string') fs.writeFileSync(appConfigPath(), appConfig, 'utf8');
    else writeAppConfig(appConfig);
    return startApplication();
  };

  const favorites = (db) =>
    db
      .prepare('SELECT user_id, path, label, icon, position FROM favorites ORDER BY position')
      .all();

  it('gives them to the first account, in their order, with the default icon where none was chosen', async () => {
    const db = await upgrade();

    expect(favorites(db)).toEqual([
      { user_id: 'u-admin', path: 'Projects', label: null, icon: 'solid:StarIcon', position: 0 },
      {
        user_id: 'u-admin',
        path: 'Photos/2024',
        label: 'Photos',
        icon: 'outline:StarIcon',
        position: 1,
      },
    ]);
  });

  it('empties the list in app-config.json and keeps the rest of the file', async () => {
    await upgrade();

    expect(readAppConfig()).toEqual({ ...APP_CONFIG, favorites: [] });
  });

  it('leaves them in app-config.json while there is no account to give them to', async () => {
    const db = await upgrade({ accounts: false });

    expect(favorites(db)).toEqual([]);
    expect(readAppConfig()).toEqual(APP_CONFIG);
  });

  it('starts anyway when app-config.json cannot be read', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    const db = await upgrade({ appConfig: '{ "favorites": [' });

    expect(schemaVersion(db)).toBe('22');
    expect(favorites(db)).toEqual([]);
    expect(reported).toHaveBeenCalledWith(
      '[DB Migration] Error migrating favorites:',
      expect.any(Error)
    );
    expect(reported).toHaveBeenCalledWith(
      '[DB Migration] Error migrating settings:',
      expect.any(Error)
    );
  });
});

/** Up to 2.1.1 (schema 6), settings lived in app-config.json. */
describe('settings kept in app-config.json (schema 6)', () => {
  const SETTINGS = {
    thumbnails: { enabled: false, size: 320, quality: 85, concurrency: 4 },
    access: { rules: [{ id: 'rule-1', path: 'Private', recursive: true, permissions: 'hidden' }] },
    branding: { appName: 'Team Files', appLogoUrl: '/logo.svg', showPoweredBy: false },
  };

  const upgrade = async (settings) => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 6);
    insert(legacy, 'users', {
      id: 'u-admin',
      email: 'admin@example.com',
      created_at: T,
      updated_at: T,
    });
    legacy.close();
    writeAppConfig({ version: 4, settings, favorites: [] });
    return startApplication();
  };

  const stored = (db) =>
    db.prepare('SELECT category, key, value FROM system_settings ORDER BY category, key').all();

  it('moves branding, thumbnails and access rules into the database as they were', async () => {
    const db = await upgrade(SETTINGS);

    expect(stored(db).map((row) => ({ ...row, value: JSON.parse(row.value) }))).toEqual([
      { category: 'branding', key: 'branding', value: SETTINGS.branding },
      { category: 'system', key: 'access', value: SETTINGS.access },
      { category: 'system', key: 'thumbnails', value: SETTINGS.thumbnails },
    ]);
  });

  it('serves the moved settings through what the application reads', async () => {
    await upgrade(SETTINGS);
    const settingsService = envContext.requireFresh('src/services/settingsService');

    const system = await settingsService.getSystemSettings();
    expect(system.thumbnails).toMatchObject({ enabled: false, size: 320, quality: 85 });
    expect(system.access.rules).toMatchObject([
      { path: 'Private', recursive: true, permissions: 'hidden' },
    ]);
    expect((await settingsService.getPublicSettings()).branding).toMatchObject({
      appName: 'Team Files',
    });
  });

  it('moves only the sections the file has', async () => {
    const db = await upgrade({ thumbnails: SETTINGS.thumbnails });

    expect(stored(db).map((row) => row.key)).toEqual(['thumbnails']);
  });

  it('moves nothing when the file holds no settings', async () => {
    const db = await upgrade({});

    expect(stored(db)).toEqual([]);
  });
});

/**
 * Integration builds of late August 2026 (schema 13) kept each account's
 * per-folder sorts and views as one JSON value per account; schema 14 made them
 * one row per folder.
 */
describe('per-folder preferences kept as one value per account (schema 13)', () => {
  const upgrade = async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 13);
    for (const id of ['u-1', 'u-2']) {
      insert(legacy, 'users', { id, email: `${id}@example.com`, created_at: T, updated_at: T });
    }
    const setting = (id, userId, key, value) =>
      insert(legacy, 'user_settings', { id, user_id: userId, key, value, updated_at: T });
    setting(
      'us-1',
      'u-1',
      'folderSorts',
      JSON.stringify({
        Projects: { by: 'name', order: 'desc', updatedAt: 1756300000000 },
        Docs: { by: 'size', order: 'sideways', updatedAt: 1756300100000 },
        Broken: null,
      })
    );
    setting(
      'us-2',
      'u-1',
      'folderViews',
      JSON.stringify({
        Projects: { mode: 'grid', updatedAt: 1756300200000 },
        Music: { mode: 'list', updatedAt: 1756300300000 },
      })
    );
    setting(
      'us-3',
      'u-2',
      'folderViews',
      JSON.stringify({ Projects: { mode: 'list', updatedAt: 1756300400000 } })
    );
    setting('us-4', 'u-2', 'folderSorts', '{ not json');
    setting('us-5', 'u-1', 'theme', '"dark"');
    legacy.close();
    return startApplication();
  };

  const at = (ms) => new Date(ms).toISOString();

  it('makes one row per account and folder, merging its sort and view under the later time', async () => {
    const db = await upgrade();

    expect(
      db
        .prepare(
          `SELECT user_id, path, sort_by, sort_order, view_mode, updated_at
             FROM folder_preferences ORDER BY user_id, path`
        )
        .all()
    ).toEqual([
      {
        user_id: 'u-1',
        path: 'Docs',
        sort_by: 'size',
        sort_order: 'asc',
        view_mode: null,
        updated_at: at(1756300100000),
      },
      {
        user_id: 'u-1',
        path: 'Music',
        sort_by: null,
        sort_order: null,
        view_mode: 'list',
        updated_at: at(1756300300000),
      },
      {
        user_id: 'u-1',
        path: 'Projects',
        sort_by: 'name',
        sort_order: 'desc',
        view_mode: 'grid',
        updated_at: at(1756300200000),
      },
      {
        user_id: 'u-2',
        path: 'Projects',
        sort_by: null,
        sort_order: null,
        view_mode: 'list',
        updated_at: at(1756300400000),
      },
    ]);
  });

  it('removes the old values, including one it could not read, and keeps the other settings', async () => {
    const db = await upgrade();

    expect(db.prepare('SELECT user_id, key FROM user_settings').all()).toEqual([
      { user_id: 'u-1', key: 'theme' },
    ]);
  });

  it('serves the carried-over preferences through what the application reads', async () => {
    await upgrade();
    const settingsService = envContext.requireFresh('src/services/settingsService');

    expect(await settingsService.getUserSettings('u-1')).toMatchObject({
      folderSorts: {
        Docs: { by: 'size', order: 'asc', updatedAt: 1756300100000 },
        Projects: { by: 'name', order: 'desc', updatedAt: 1756300200000 },
      },
      folderViews: {
        Music: { mode: 'list', updatedAt: 1756300300000 },
        Projects: { mode: 'grid', updatedAt: 1756300200000 },
      },
    });
  });
});

/**
 * The first search index (schema 16) knew documents by path alone. Schema 17
 * throws it away rather than converting it; what matters is that it also throws
 * away the record that the index was complete, or search would answer from an
 * empty index as though it were whole.
 */
describe('the search index of schema 16', () => {
  it('is discarded with its completion record, so the next pass rebuilds it', async () => {
    const { configDir } = await prepareEnv();
    const legacy = createLegacyDatabase(configDir, 16);
    insert(legacy, 'search_documents', {
      id: 1,
      path: 'Projects/brochure.pdf',
      mtime_ms: 1700000000000,
      size: 2048,
      indexed_at: T,
    });
    legacy.prepare('INSERT INTO search_terms (rowid, text) VALUES (?, ?)').run(1, 'brochure');
    insert(legacy, 'meta', { key: 'search_index_complete_at', value: T });
    legacy.close();

    const db = await startApplication();
    const index = await envContext.requireFresh('src/services/indexDb').getIndexDb();
    const searchIndexStore = envContext.requireFresh('src/services/searchIndexStore');

    expect(schemaVersion(db)).toBe('22');
    expect(
      index
        .prepare('PRAGMA table_info(search_documents)')
        .all()
        .map((c) => c.name)
    ).toContain('dir');
    expect(index.prepare('SELECT COUNT(*) FROM search_documents').pluck().get()).toBe(0);
    expect(
      index.prepare("SELECT rowid FROM search_terms WHERE search_terms MATCH 'brochure'").all()
    ).toEqual([]);
    expect(searchIndexStore.isReady(index)).toBe(false);
  });
});
