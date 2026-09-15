import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';
import { createLegacyDatabase } from '../helpers/legacy-app-db.js';

/**
 * The indexes leave app.db for a database of their own under the cache.
 *
 * What is at stake is two things at once. app.db must come out of it with
 * everything that is not an index — it is the one that cannot be rebuilt. And
 * the index must come out of it as it was: the full-text index keeps no text,
 * so an index lost on the way is a pass over the whole volume, hours on a large
 * one. So each test starts from app.db as 3.6.0 leaves it, holding a real
 * index, and asks both files afterwards.
 */

let envContext;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const WORDS = ['invoice', 'budget', 'meeting', 'zebra', 'quarterly', 'nothingmatchesthis'];

const DOCUMENTS = [
  ['Finance/2026/invoice-001.txt', 'Invoice for the quarterly budget review'],
  ['Finance/2026/invoice-002.txt', 'Second invoice, budget line 14'],
  ['Notes/meeting.md', 'Meeting notes: budget, hiring, the zebra crossing'],
  ['Notes/old.md', 'An old note nobody reads'],
  ['Photos/readme.txt', 'Quarterly photos of the zebra enclosure'],
];

const appDbFile = () => path.join(envContext.configDir, 'app.db');
const indexDbFile = () => path.join(envContext.cacheDir, 'index.db');

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();

const matches = (db) =>
  Object.fromEntries(
    WORDS.map((word) => [
      word,
      db
        .prepare(
          `SELECT d.path FROM search_terms t JOIN search_documents d ON d.id = t.rowid
           WHERE search_terms MATCH ? ORDER BY d.path`
        )
        .pluck()
        .all(word),
    ])
  );

/**
 * app.db as 3.6.0 leaves it: schema 19 is reached from 3.5.0's schema by the
 * application itself, then an index is written into it the way the indexer
 * writes one, including a deletion, which a contentless index records apart.
 */
const createInstallationWithIndex = async () => {
  const legacy = createLegacyDatabase(envContext.configDir, 17);
  legacy.close();
  // Reach schema 19 through the application's own migrations, without the
  // move: that is the file an upgrade to this release starts from.
  const indexDb = envContext.requireFresh('src/services/indexDb');
  const move = vi.spyOn(indexDb, 'moveIndexesOutOf').mockReturnValue({ moved: false });
  const dbModule = envContext.requireFresh('src/services/db');
  const db = await dbModule.getDb();
  expect(move).toHaveBeenCalled();
  move.mockRestore();

  const now = '2026-09-15T08:00:00.000Z';
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'ada@example.com', 1, 'ada', 'Ada', '["admin"]', ?, ?)`
  ).run(now, now);
  const insertDocument = db.prepare(
    'INSERT INTO search_documents (path, dir, mtime_ms, size, indexed_at) VALUES (?, ?, 1, 1, ?)'
  );
  const insertTerms = db.prepare('INSERT INTO search_terms (rowid, text) VALUES (?, ?)');
  db.transaction(() => {
    for (const [documentPath, text] of DOCUMENTS) {
      const { lastInsertRowid } = insertDocument.run(
        documentPath,
        path.dirname(documentPath),
        '2026-09-15T08:00:00.000Z'
      );
      insertTerms.run(lastInsertRowid, text);
    }
  })();
  const old = db
    .prepare("SELECT id FROM search_documents WHERE path = 'Notes/old.md'")
    .pluck()
    .get();
  db.prepare('DELETE FROM search_terms WHERE rowid = ?').run(old);
  db.prepare('DELETE FROM search_documents WHERE id = ?').run(old);

  db.prepare(
    "INSERT INTO folder_size_index (path_hash, parent_hash, volume, relative_path, size_bytes, entry_count) VALUES ('h-root', NULL, 'Volume', '', 4096, 3), ('h-fin', 'h-root', 'Volume', 'Finance', 2048, 2)"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('search_index_complete_at', '2026-09-15T08:30:00.000Z'), ('folder_size_index_version:Volume:abc', '2'), ('something_else', 'app')"
  ).run();

  const expected = matches(db);
  dbModule.closeDb();
  return { expected };
};

/** Start the application again on the same directories. */
const restart = async () => {
  envContext.requireFresh('src/services/indexDb').closeIndexDb?.();
  const dbModule = envContext.requireFresh('src/services/db');
  const indexDb = envContext.requireFresh('src/services/indexDb');
  const index = await indexDb.getIndexDb();
  const app = await dbModule.getDb();
  return { app, index, dbModule, indexDb };
};

describe('moving the indexes out of app.db', () => {
  it('carries the search index over as it was: every query answers the same', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    expect(expected.budget).toHaveLength(3);
    expect(expected.zebra).toHaveLength(2);

    const { index } = await restart();

    expect(matches(index)).toEqual(expected);
    expect(() =>
      index.exec("INSERT INTO search_terms (search_terms, rank) VALUES ('integrity-check', 1)")
    ).not.toThrow();
    expect(
      index.prepare("SELECT value FROM meta WHERE key = 'search_index_complete_at'").pluck().get()
    ).toBe('2026-09-15T08:30:00.000Z');
  });

  it('keeps an index that goes on working: a deletion and an addition after the move', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const { index } = await restart();

    const meeting = index
      .prepare("SELECT id FROM search_documents WHERE path = 'Notes/meeting.md'")
      .pluck()
      .get();
    index.prepare('DELETE FROM search_terms WHERE rowid = ?').run(meeting);
    index.prepare('INSERT INTO search_terms (rowid, text) VALUES (?, ?)').run(9999, 'zebra again');

    expect(
      index
        .prepare("SELECT rowid FROM search_terms WHERE search_terms MATCH 'zebra' ORDER BY rowid")
        .pluck()
        .all()
    ).not.toContain(meeting);
    expect(
      index.prepare("SELECT rowid FROM search_terms WHERE search_terms MATCH 'zebra'").pluck().all()
    ).toContain(9999);
    expect(() =>
      index.exec("INSERT INTO search_terms (search_terms, rank) VALUES ('integrity-check', 1)")
    ).not.toThrow();
  });

  it('carries the folder sizes and their version over, so the volume is not walked again', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const { index } = await restart();

    expect(
      index
        .prepare(
          'SELECT relative_path, size_bytes, entry_count FROM folder_size_index ORDER BY relative_path'
        )
        .all()
    ).toEqual([
      { relative_path: '', size_bytes: 4096, entry_count: 3 },
      { relative_path: 'Finance', size_bytes: 2048, entry_count: 2 },
    ]);
    expect(
      index
        .prepare("SELECT value FROM meta WHERE key = 'folder_size_index_version:Volume:abc'")
        .pluck()
        .get()
    ).toBe('2');
  });

  it('leaves app.db with everything that is not an index, and nothing that is', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const { app, index } = await restart();

    const appTables = tableNames(app);
    expect(appTables).not.toContain('search_documents');
    expect(appTables).not.toContain('folder_size_index');
    expect(appTables.some((name) => name.startsWith('search_terms'))).toBe(false);
    expect(appTables).toEqual(
      expect.arrayContaining(['users', 'shares', 'trash_items', 'file_versions'])
    );
    expect(app.prepare('SELECT email FROM users').pluck().all()).toContain('ada@example.com');
    expect(app.prepare("SELECT value FROM meta WHERE key = 'something_else'").pluck().get()).toBe(
      'app'
    );
    expect(
      app
        .prepare(
          "SELECT COUNT(*) FROM meta WHERE key = 'search_index_complete_at' OR key LIKE 'folder_size_index_version:%'"
        )
        .pluck()
        .get()
    ).toBe(0);
    expect(app.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(
      '19'
    );

    // And the index file holds the indexes only.
    const indexTables = tableNames(index);
    expect(indexTables).not.toContain('users');
    expect(indexTables).not.toContain('shares');
    expect(
      index.prepare("SELECT COUNT(*) FROM meta WHERE key = 'something_else'").pluck().get()
    ).toBe(0);
    expect(Number(index.pragma('auto_vacuum', { simple: true }))).toBe(2);
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);
  });

  it('happens once: the next start neither copies nor loses anything', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    const first = await restart();
    first.indexDb.closeIndexDb();
    first.dbModule.closeDb();

    const prepare = vi.spyOn(Database.prototype, 'prepare');
    const { index } = await restart();

    expect(prepare.mock.calls.some(([sql]) => /VACUUM INTO/i.test(sql))).toBe(false);
    expect(matches(index)).toEqual(expected);
  });

  it('keeps the index already in the cache over tables an older image left in app.db', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    const first = await restart();
    first.indexDb.closeIndexDb();
    first.dbModule.closeDb();

    // An older image sharing /config puts its tables back and writes into them.
    const stale = new Database(appDbFile());
    stale.exec(
      'CREATE TABLE folder_size_index (path_hash TEXT PRIMARY KEY, parent_hash TEXT, volume TEXT NOT NULL, relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, entry_count INTEGER NOT NULL DEFAULT 0, last_delta_at DATETIME, last_full_scan_at DATETIME, dirty INTEGER NOT NULL DEFAULT 0)'
    );
    stale
      .prepare(
        "INSERT INTO folder_size_index (path_hash, volume, relative_path, size_bytes) VALUES ('stale', 'Volume', 'Old', 1)"
      )
      .run();
    stale.close();

    const { app, index } = await restart();

    expect(tableNames(app)).not.toContain('folder_size_index');
    expect(
      index
        .prepare("SELECT COUNT(*) FROM folder_size_index WHERE path_hash = 'stale'")
        .pluck()
        .get()
    ).toBe(0);
    expect(matches(index)).toEqual(expected);
  });

  it('leaves app.db untouched when the copy fails, and starts with an index that fills again', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const prepare = Database.prototype.prepare;
    const refuse = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
      if (/VACUUM INTO/i.test(sql)) {
        throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
      }
      return prepare.call(this, sql);
    });

    const { app, index } = await restart();

    expect(app.prepare('SELECT COUNT(*) FROM search_documents').pluck().get()).toBe(4);
    expect(app.prepare('SELECT COUNT(*) FROM folder_size_index').pluck().get()).toBe(2);
    expect(index.prepare('SELECT COUNT(*) FROM search_documents').pluck().get()).toBe(0);
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);
    refuse.mockRestore();
  });

  it('gives a new installation an index database from the start and no index tables in app.db', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { app, index } = await restart();

    expect(fs.existsSync(indexDbFile())).toBe(true);
    expect(tableNames(index)).toEqual(
      expect.arrayContaining(['meta', 'search_documents', 'folder_size_index'])
    );
    expect(tableNames(app)).not.toContain('search_documents');
    expect(tableNames(app)).not.toContain('folder_size_index');
  });
});

describe('the maintenance pass', () => {
  it('hands the index database its free space back too', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { index } = await restart();
    index.exec('CREATE TABLE scratch (payload BLOB)');
    const insert = index.prepare('INSERT INTO scratch (payload) VALUES (?)');
    index.transaction(() => {
      for (let i = 0; i < 8000; i += 1) insert.run(Buffer.alloc(4000, i % 251));
    })();
    index.exec('DELETE FROM scratch');
    const pageSize = Number(index.pragma('page_size', { simple: true }));
    expect(Number(index.pragma('freelist_count', { simple: true })) * pageSize).toBeGreaterThan(
      16 * 1024 * 1024
    );

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const results = await maintenance.runPass();

    expect(results['index.db'].reclaimedBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(Number(index.pragma('freelist_count', { simple: true }))).toBe(0);
  });
});
