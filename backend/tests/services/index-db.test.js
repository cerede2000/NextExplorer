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
 * index, and asks both files afterwards — including after the starts that go
 * wrong: a copy that fails, a process killed with its log files left behind,
 * everything that starts with the server asking for the database at once.
 */

let envContext;
let started = null;

afterEach(async () => {
  vi.restoreAllMocks();
  started = null;
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

const metaValue = (db, key) =>
  db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) ?? null;

const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

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

const passesIntegrityCheck = (db) => {
  db.exec("INSERT INTO search_terms (search_terms, rank) VALUES ('integrity-check', 1)");
  return true;
};

/** Make the copy out of app.db fail, the way a full cache directory would. */
const refuseTheCopy = () => {
  const prepare = Database.prototype.prepare;
  return vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (sql) {
    if (/ATTACH DATABASE/i.test(sql)) {
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    }
    return prepare.call(this, sql);
  });
};

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

/** Stop what the last start opened, then start the application again. */
const restart = async () => {
  if (started) {
    started.indexDb.closeIndexDb();
    started.dbModule.closeDb();
  }
  const dbModule = envContext.requireFresh('src/services/db');
  const indexDb = envContext.requireFresh('src/services/indexDb');
  const index = await indexDb.getIndexDb();
  const app = await dbModule.getDb();
  started = { dbModule, indexDb };
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
    expect(passesIntegrityCheck(index)).toBe(true);
    expect(metaValue(index, 'search_index_complete_at')).toBe('2026-09-15T08:30:00.000Z');
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

    const zebra = index
      .prepare("SELECT rowid FROM search_terms WHERE search_terms MATCH 'zebra'")
      .pluck()
      .all();
    expect(zebra).not.toContain(meeting);
    expect(zebra).toContain(9999);
    expect(passesIntegrityCheck(index)).toBe(true);
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
    expect(metaValue(index, 'folder_size_index_version:Volume:abc')).toBe('2');
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
    expect(metaValue(app, 'something_else')).toBe('app');
    expect(
      app
        .prepare(
          "SELECT COUNT(*) FROM meta WHERE key = 'search_index_complete_at' OR key LIKE 'folder_size_index_version:%' OR key LIKE 'index_%'"
        )
        .pluck()
        .get()
    ).toBe(0);
    expect(metaValue(app, 'schema_version')).toBe('20');

    // And the index file holds the indexes only.
    const indexTables = tableNames(index);
    expect(indexTables).not.toContain('users');
    expect(indexTables).not.toContain('shares');
    expect(metaValue(index, 'something_else')).toBeNull();
    expect(metaValue(index, 'index_db_ready_at')).not.toBeNull();
    expect(Number(index.pragma('auto_vacuum', { simple: true }))).toBe(2);
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);
  });

  it('never writes anything but the indexes under the cache directory, not even on the way', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const seen = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // The staging file, just before it becomes index.db.
      seen.push(fs.readFileSync(from).includes('ada@example.com'));
      return rename(from, to);
    });

    await restart();

    expect(seen).toEqual([false]);
    for (const name of fs.readdirSync(envContext.cacheDir)) {
      const file = path.join(envContext.cacheDir, name);
      if (fs.statSync(file).isFile()) {
        expect(fs.readFileSync(file).includes('ada@example.com'), name).toBe(false);
      }
    }
  });

  it('happens once: the next start neither copies nor loses anything', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    await restart();

    const prepare = vi.spyOn(Database.prototype, 'prepare');
    const { index } = await restart();

    expect(prepare.mock.calls.some(([sql]) => /ATTACH DATABASE/i.test(sql))).toBe(false);
    expect(matches(index)).toEqual(expected);
  });

  it('keeps the index already in the cache over tables an older image left in app.db', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    await restart();
    started.indexDb.closeIndexDb();
    started.dbModule.closeDb();
    started = null;

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

describe('a move that goes wrong', () => {
  it('keeps the index in app.db when the copy fails, and carries it over at the next start', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();

    const refuse = refuseTheCopy();
    const first = await restart();
    refuse.mockRestore();

    // Nothing dropped: the index is still whole where it was.
    expect(count(first.app, 'search_documents')).toBe(4);
    expect(count(first.app, 'folder_size_index')).toBe(2);
    expect(matches(first.app)).toEqual(expected);
    expect(metaValue(first.app, 'index_move_failed_attempts')).toBe('1');
    // Meanwhile the indexes have a file of their own to fill, not yet the index.
    expect(count(first.index, 'search_documents')).toBe(0);
    expect(metaValue(first.index, 'index_db_ready_at')).toBeNull();
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);

    const { app, index } = await restart();

    expect(matches(index)).toEqual(expected);
    expect(passesIntegrityCheck(index)).toBe(true);
    expect(tableNames(app)).not.toContain('search_documents');
    expect(metaValue(app, 'index_move_failed_attempts')).toBeNull();
  });

  it('does not throw the index away when several callers ask for the database while the copy fails', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    if (started) started = null;

    const refuse = refuseTheCopy();
    const dbModule = envContext.requireFresh('src/services/db');
    const indexDb = envContext.requireFresh('src/services/indexDb');
    // What the server starts right after it listens, all at once.
    const handles = await Promise.all([
      dbModule.getDb(),
      indexDb.getIndexDb(),
      dbModule.getDb(),
      indexDb.getIndexDb(),
      dbModule.getDb(),
    ]);
    refuse.mockRestore();
    started = { dbModule, indexDb };

    const app = handles[0];
    expect(new Set([handles[0], handles[2], handles[4]]).size).toBe(1);
    expect(count(app, 'search_documents')).toBe(4);
    expect(matches(app)).toEqual(expected);
  });

  it('opens app.db once and copies once when everything starts together', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();

    const prepare = vi.spyOn(Database.prototype, 'prepare');
    const dbModule = envContext.requireFresh('src/services/db');
    const indexDb = envContext.requireFresh('src/services/indexDb');
    const [first, index, second, third] = await Promise.all([
      dbModule.getDb(),
      indexDb.getIndexDb(),
      dbModule.getDb(),
      dbModule.getDb(),
    ]);
    started = { dbModule, indexDb };

    expect(new Set([first, second, third]).size).toBe(1);
    expect(prepare.mock.calls.filter(([sql]) => /ATTACH DATABASE/i.test(sql))).toHaveLength(1);
    expect(matches(index)).toEqual(expected);
  });

  it('gives up after several starts that all failed, and lets the index fill from the files', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await createInstallationWithIndex();
    const { MAX_MOVE_ATTEMPTS } = envContext.requireFresh('src/services/indexDb');

    const refuse = refuseTheCopy();
    let last;
    for (let attempt = 1; attempt <= MAX_MOVE_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await restart();
      if (attempt < MAX_MOVE_ATTEMPTS) {
        expect(count(last.app, 'search_documents'), `start ${attempt}`).toBe(4);
      }
    }
    refuse.mockRestore();

    expect(tableNames(last.app)).not.toContain('search_documents');
    expect(metaValue(last.app, 'index_move_failed_attempts')).toBeNull();

    const { index } = await restart();
    expect(count(index, 'search_documents')).toBe(0);
    expect(metaValue(index, 'index_db_ready_at')).not.toBeNull();
  });

  it('does not start a copy the cache directory has no room for', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    const full = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1, bsize: 4096 });

    const first = await restart();
    full.mockRestore();

    expect(count(first.app, 'search_documents')).toBe(4);
    expect(metaValue(first.app, 'index_move_failed_attempts')).toBe('1');
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);

    const { index } = await restart();
    expect(matches(index)).toEqual(expected);
  });

  it('is not stopped by a staging file an interrupted move left behind', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();
    fs.writeFileSync(`${indexDbFile()}.moving`, 'half a database, from a start that was killed');
    fs.writeFileSync(`${indexDbFile()}.moving-journal`, 'and its journal');

    const { index } = await restart();

    expect(matches(index)).toEqual(expected);
    expect(fs.existsSync(`${indexDbFile()}.moving`)).toBe(false);
    expect(fs.existsSync(`${indexDbFile()}.moving-journal`)).toBe(false);
  });

  it('does not replay a log a killed process left beside index.db onto the moved index', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { expected } = await createInstallationWithIndex();

    // A real write-ahead log from another index.db, kept past a kill: written
    // with checkpoints off, saved, and put back once that file is gone.
    const other = new Database(indexDbFile());
    other.pragma('journal_mode = WAL');
    other.pragma('wal_autocheckpoint = 0');
    other.exec('CREATE VIRTUAL TABLE search_terms USING fts5(text)');
    const insert = other.prepare('INSERT INTO search_terms (rowid, text) VALUES (?, ?)');
    other.transaction(() => {
      for (let i = 1; i <= 2000; i += 1) insert.run(i, `other words ${i} zebra budget`);
    })();
    const wal = fs.readFileSync(`${indexDbFile()}-wal`);
    const shm = fs.readFileSync(`${indexDbFile()}-shm`);
    other.close();
    fs.rmSync(indexDbFile(), { force: true });
    fs.writeFileSync(`${indexDbFile()}-wal`, wal);
    fs.writeFileSync(`${indexDbFile()}-shm`, shm);

    const { index } = await restart();

    expect(matches(index)).toEqual(expected);
    expect(passesIntegrityCheck(index)).toBe(true);
  });

  it('replaces an index.db that cannot be read instead of failing every search', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    await restart();
    started.indexDb.closeIndexDb();
    started.dbModule.closeDb();
    started = null;
    fs.writeFileSync(indexDbFile(), Buffer.alloc(8192, 7));

    const { index } = await restart();

    expect(count(index, 'search_documents')).toBe(0);
    expect(fs.readFileSync(indexDbFile()).subarray(0, 15).toString()).toBe('SQLite format 3');
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

  it('goes on to the index database when app.db fails', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const { dbModule } = await restart();
    vi.spyOn(dbModule, 'getDb').mockRejectedValue(new Error('disk I/O error'));

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const results = await maintenance.runPass();

    expect(results['app.db'].error).toBeInstanceOf(Error);
    expect(results['index.db']).toMatchObject({ reclaimedBytes: 0, skipped: 'below-threshold' });
  });

  it('does not create an index database for a server that uses none', async () => {
    envContext = await setupTestEnv({ tag: 'index-db-' });
    const dbModule = envContext.requireFresh('src/services/db');
    await dbModule.getDb();

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const results = await maintenance.runPass();

    expect(fs.existsSync(indexDbFile())).toBe(false);
    expect(results['index.db']).toBeUndefined();
  });
});
