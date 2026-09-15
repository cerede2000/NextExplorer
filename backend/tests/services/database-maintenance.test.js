import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Handing the database's free space back.
 *
 * SQLite keeps what a deletion frees inside the file, and /config is what gets
 * backed up: an installation measured 2,159 MB of app.db for 160 MB of data.
 * These tests start from files shaped like that one — a database created the
 * way every release so far created it, full of pages nothing uses — and check
 * that the space leaves the file, and that nothing else does.
 */

const MB = 1024 * 1024;

let envContext;

afterEach(async () => {
  vi.restoreAllMocks();
  if (envContext) await envContext.cleanup();
  envContext = null;
});

const prepareEnv = async () => {
  envContext = await setupTestEnv({ tag: 'db-maintenance-' });
  return envContext;
};

const dbFile = () => path.join(envContext.configDir, 'app.db');

const pragma = (db, name) => Number(db.pragma(name, { simple: true }));

const freeBytes = (db) => pragma(db, 'freelist_count') * pragma(db, 'page_size');

const fileBytes = (db) => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  return fs.statSync(dbFile()).size;
};

/** Write roughly `megabytes` into a table, then delete it: pages nothing uses. */
const leaveFreePages = (db, megabytes) => {
  db.exec('CREATE TABLE IF NOT EXISTS bulk (id INTEGER PRIMARY KEY, payload BLOB)');
  const insert = db.prepare('INSERT INTO bulk (payload) VALUES (?)');
  const rows = Math.ceil((megabytes * MB) / 4000);
  db.transaction(() => {
    for (let i = 0; i < rows; i += 1) insert.run(Buffer.alloc(4000, i % 251));
  })();
  db.exec('DELETE FROM bulk');
  db.pragma('wal_checkpoint(TRUNCATE)');
};

/**
 * A database as every release before this one left it: no auto-vacuum, a row
 * someone cares about, and a large deletion behind it.
 */
const createDatabaseFromBefore = (megabytesFreed) => {
  const db = new Database(dbFile());
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE keepsake (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  db.prepare('INSERT INTO keepsake (note) VALUES (?)').run('still here');
  leaveFreePages(db, megabytesFreed);
  expect(pragma(db, 'auto_vacuum')).toBe(0);
  const before = fs.statSync(dbFile()).size;
  db.close();
  return before;
};

const openApplicationDatabase = async () => {
  const dbModule = envContext.requireFresh('src/services/db');
  return { dbModule, db: await dbModule.getDb() };
};

describe('a database created from now on', () => {
  it('starts in the mode that lets free space be handed back, with no rewrite needed', async () => {
    await prepareEnv();
    const exec = vi.spyOn(Database.prototype, 'exec');
    const { db } = await openApplicationDatabase();

    expect(pragma(db, 'auto_vacuum')).toBe(2);
    expect(pragma(db, 'journal_size_limit')).toBe(64 * MB);
    // A new file is created in the right mode rather than rewritten into it.
    expect(exec.mock.calls.some(([sql]) => /^\s*VACUUM\s*$/i.test(sql))).toBe(false);
  });
});

describe('a database created before', () => {
  it('is rewritten once when it is opened: the free space leaves the file and the rows stay', async () => {
    await prepareEnv();
    const before = createDatabaseFromBefore(40);
    expect(before).toBeGreaterThan(40 * MB);

    const { db } = await openApplicationDatabase();

    expect(pragma(db, 'auto_vacuum')).toBe(2);
    expect(freeBytes(db)).toBe(0);
    expect(fileBytes(db)).toBeLessThan(5 * MB);
    expect(db.prepare('SELECT note FROM keepsake').pluck().all()).toEqual(['still here']);
  });

  it('is not rewritten again at the next start', async () => {
    await prepareEnv();
    createDatabaseFromBefore(1);
    const { dbModule } = await openApplicationDatabase();
    dbModule.closeDb();

    const vacuum = vi.spyOn(Database.prototype, 'exec');
    await openApplicationDatabase();

    expect(vacuum.mock.calls.some(([sql]) => /VACUUM/i.test(sql))).toBe(false);
  });

  it('still opens when the rewrite fails, keeps everything, and the next start tries again', async () => {
    await prepareEnv();
    createDatabaseFromBefore(20);
    const exec = Database.prototype.exec;
    const refuse = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (sql) {
      if (/^\s*VACUUM\s*$/i.test(sql)) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      return exec.call(this, sql);
    });

    const { dbModule, db } = await openApplicationDatabase();

    expect(pragma(db, 'auto_vacuum')).toBe(0);
    expect(db.prepare('SELECT note FROM keepsake').pluck().all()).toEqual(['still here']);
    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    await expect(maintenance.reclaimFreePages(db)).resolves.toMatchObject({
      reclaimedBytes: 0,
      skipped: 'not-incremental',
    });

    refuse.mockRestore();
    dbModule.closeDb();
    const { db: reopened } = await openApplicationDatabase();
    expect(pragma(reopened, 'auto_vacuum')).toBe(2);
    expect(freeBytes(reopened)).toBe(0);
  });
});

describe('the pass', () => {
  it('hands free pages back to the filesystem and leaves the rows alone', async () => {
    await prepareEnv();
    const { db } = await openApplicationDatabase();
    db.exec('CREATE TABLE keepsake (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
    db.prepare('INSERT INTO keepsake (note) VALUES (?)').run('still here');
    leaveFreePages(db, 40);
    const before = fileBytes(db);
    expect(freeBytes(db)).toBeGreaterThan(30 * MB);

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const result = await maintenance.runPass();

    expect(freeBytes(db)).toBe(0);
    expect(result.reclaimedBytes).toBeGreaterThan(30 * MB);
    expect(fileBytes(db)).toBeLessThan(before - 30 * MB);
    expect(db.prepare('SELECT note FROM keepsake').pluck().all()).toEqual(['still here']);
  });

  it('leaves a little free space where it is: SQLite reuses it, and handing it back costs writes', async () => {
    await prepareEnv();
    const { db } = await openApplicationDatabase();
    leaveFreePages(db, 4);
    const free = freeBytes(db);
    expect(free).toBeGreaterThan(0);

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    const result = await maintenance.runPass();

    expect(result).toMatchObject({ reclaimedBytes: 0, skipped: 'below-threshold' });
    expect(freeBytes(db)).toBe(free);
  });

  it('frees the pages while someone is reading, and the file shrinks once they are done', async () => {
    await prepareEnv();
    const { db } = await openApplicationDatabase();
    db.exec('CREATE TABLE keepsake (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
    db.prepare('INSERT INTO keepsake (note) VALUES (?)').run('still here');
    leaveFreePages(db, 40);
    const before = fileBytes(db);

    const reader = new Database(dbFile(), { readonly: true });
    const rows = reader.prepare('SELECT note FROM keepsake').iterate();
    rows.next();

    const maintenance = envContext.requireFresh('src/services/databaseMaintenance');
    await expect(maintenance.runPass()).resolves.toMatchObject({ freeBytes: 0 });
    expect(freeBytes(db)).toBe(0);

    rows.return();
    reader.close();
    expect(fileBytes(db)).toBeLessThan(before - 30 * MB);
  });

  it('cuts the write-ahead log back after a large write', async () => {
    await prepareEnv();
    const { db } = await openApplicationDatabase();
    db.exec('CREATE TABLE bulk2 (id INTEGER PRIMARY KEY, payload BLOB)');
    const insert = db.prepare('INSERT INTO bulk2 (payload) VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 25000; i += 1) insert.run(Buffer.alloc(4000, i % 251));
    })();
    db.pragma('wal_checkpoint(PASSIVE)');
    // One more write after the checkpoint is what applies the limit.
    db.prepare('INSERT INTO bulk2 (payload) VALUES (?)').run(Buffer.alloc(10));
    db.pragma('wal_checkpoint(PASSIVE)');

    expect(fs.statSync(`${dbFile()}-wal`).size).toBeLessThanOrEqual(64 * MB);
  });
});
