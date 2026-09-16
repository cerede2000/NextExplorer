const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { directories } = require('../config');
const logger = require('../utils/logger');
const databaseMaintenance = require('./databaseMaintenance');
const { SEARCH_INDEX_DDL } = require('./searchIndexStore');

/**
 * The indexes, in a database of their own under the cache directory.
 *
 * app.db holds what cannot be made again — accounts, shares, settings, what
 * the trash and the file versions keep track of — and is what gets backed up.
 * The search index and the folder sizes are the opposite: every row in them
 * was read from a file that is still there, they are rewritten all day long,
 * and they were most of app.db. One installation's backup of /config carried
 * 2,159 MB of it for 160 MB of settings and accounts.
 *
 * So they live under CACHE_DIR, next to the sessions, where losing the file
 * costs a pass over the volume rather than anyone's data. Keeping them apart
 * also gives each file its own writer: an indexing pass no longer queues
 * behind a sign-in for the one write lock, nor a sign-in behind a pass.
 *
 * Nothing joins an index to the application's tables, so nothing else had to
 * change but where the connection comes from.
 */

const FILE_NAME = 'index.db';
const INDEX_TABLES = ['search_terms', 'search_documents', 'folder_size_index'];
// Where the rows are. A full-text index keeps its own in the four tables named
// after it; `search_terms` itself holds none.
const COPIED_TABLES = [
  'search_documents',
  'folder_size_index',
  'search_terms_config',
  'search_terms_data',
  'search_terms_docsize',
  'search_terms_idx',
];
// What the indexes record about themselves in `meta`, and nothing else does.
const INDEX_META = "key = 'search_index_complete_at' OR key LIKE 'folder_size_index_version:%'";
// Written into index.db once it is the index: carried over whole, or created
// with nothing left in app.db to carry.
const READY_KEY = 'index_db_ready_at';
// Kept in app.db while carrying the indexes over keeps failing.
const ATTEMPTS_KEY = 'index_move_failed_attempts';
const MAX_MOVE_ATTEMPTS = 3;
// Room asked of the cache directory, against what the indexes occupy in app.db.
const SPACE_FACTOR = 1.5;

let indexDbInstance = null;
let opening = null;

const getIndexDbPath = () => path.join(directories.cache, FILE_NAME);

const toMb = (bytes) => Math.round(bytes / (1024 * 1024));

const tablesIn = (db) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all()
  );

const holdsRows = (db, tables, names) =>
  names.some(
    (name) =>
      tables.has(name) && db.prepare(`SELECT EXISTS (SELECT 1 FROM "${name}")`).pluck().get()
  );

const metaValue = (db, key) => {
  try {
    return db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) ?? null;
  } catch {
    return null;
  }
};

const removeFile = (file) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
};

const syncDirectory = (directory) => {
  try {
    const fd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* not every platform can sync a directory; the rename stands either way */
  }
};

const isUnreadable = (error) =>
  typeof error?.code === 'string' &&
  (error.code.startsWith('SQLITE_CORRUPT') || error.code === 'SQLITE_NOTADB');

const createIndexSchema = (db) => {
  // Required here: db.js requires this module.
  const { FOLDER_SIZE_INDEX_DDL } = require('./db');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(SEARCH_INDEX_DDL);
  db.exec(FOLDER_SIZE_INDEX_DDL);
};

/**
 * Whether the index.db in the cache is the index, rather than a file begun
 * empty while carrying the indexes out of app.db was still to be done.
 */
const cacheHoldsTheIndex = (file, movePending) => {
  if (!fs.existsSync(file)) return false;
  let db = null;
  try {
    db = new Database(file, { fileMustExist: true });
    if (metaValue(db, READY_KEY)) return true;
    if (movePending) return false;
    // A file from before the mark existed is the index if it holds one.
    return holdsRows(db, tablesIn(db), ['search_documents', 'folder_size_index']);
  } catch {
    // Unreadable: nothing in it is worth keeping over what app.db holds.
    return false;
  } finally {
    db?.close();
  }
};

const bytesOfIndexes = (appDb) => {
  try {
    const names = appDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE tbl_name IN (${COPIED_TABLES.map(() => '?').join(', ')})`
      )
      .pluck()
      .all(...COPIED_TABLES);
    if (names.length === 0) return 0;
    return appDb
      .prepare(
        `SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name IN (${names.map(() => '?').join(', ')})`
      )
      .pluck()
      .get(...names);
  } catch {
    // dbstat is a compile-time option; without it the copy is tried regardless.
    return 0;
  }
};

const ensureRoomFor = (directory, bytes) => {
  if (!bytes || typeof fs.statfsSync !== 'function') return;
  let stats;
  try {
    stats = fs.statfsSync(directory);
  } catch {
    return;
  }
  const available = Number(stats.bavail) * Number(stats.bsize);
  const needed = Math.ceil(bytes * SPACE_FACTOR);
  if (available < needed) {
    throw Object.assign(
      new Error(
        `The cache directory has ${toMb(available)} MB free; carrying the indexes over needs ${toMb(needed)} MB`
      ),
      { code: 'ENOSPC' }
    );
  }
};

/**
 * Copy the indexes app.db holds into a new index.db.
 *
 * Only the index tables travel: a new file is given the index schema, attached
 * to app.db, and filled from it. The full-text index keeps no text, so its rows
 * cannot be rebuilt from anything but the files; they are copied as they are,
 * out of the four tables SQLite keeps them in. SQLite refuses writes into
 * those, and better-sqlite3 lifts the refusal only in unsafe mode, so unsafe
 * mode covers this one copy between identical definitions, and nothing else.
 *
 * Written beside its destination and renamed into place, so a file named
 * index.db is always a finished one. Nothing but the indexes is ever written
 * under the cache directory.
 */
const copyIndexesInto = (appDb, destination) => {
  const staging = `${destination}.moving`;
  removeFile(staging);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  ensureRoomFor(path.dirname(destination), bytesOfIndexes(appDb));

  let attached = false;
  try {
    const copy = new Database(staging);
    try {
      databaseMaintenance.configureStorage(copy);
      createIndexSchema(copy);
    } finally {
      copy.close();
    }

    appDb.prepare('ATTACH DATABASE ? AS moving').run(staging);
    attached = true;
    const present = tablesIn(appDb);
    appDb.unsafeMode(true);
    try {
      appDb.transaction(() => {
        for (const table of COPIED_TABLES) {
          if (present.has(table)) {
            // By name: a column added to one side later must not shift the rest.
            const source = new Set(appDb.pragma(`main.table_info("${table}")`).map((c) => c.name));
            const columns = appDb
              .pragma(`moving.table_info("${table}")`)
              .map((c) => `"${c.name}"`)
              .filter((quoted) => source.has(quoted.slice(1, -1)))
              .join(', ');
            appDb.exec(`DELETE FROM moving."${table}"`);
            appDb.exec(
              `INSERT INTO moving."${table}" (${columns}) SELECT ${columns} FROM main."${table}"`
            );
          }
        }
        if (present.has('meta')) {
          appDb.exec(
            `INSERT OR REPLACE INTO moving.meta (key, value) SELECT key, value FROM main.meta WHERE ${INDEX_META}`
          );
        }
        appDb
          .prepare('INSERT OR REPLACE INTO moving.meta (key, value) VALUES (?, ?)')
          .run(READY_KEY, new Date().toISOString());
      })();
    } finally {
      appDb.unsafeMode(false);
    }
    appDb.exec('DETACH DATABASE moving');
    attached = false;

    // A log or shared-memory file left beside index.db by a process that was
    // killed belongs to the file being replaced. Left in place, SQLite replays
    // it onto the new file and the index is corrupt for good.
    removeFile(destination);
    fs.renameSync(staging, destination);
    syncDirectory(path.dirname(destination));
  } catch (error) {
    if (attached) {
      try {
        appDb.exec('DETACH DATABASE moving');
      } catch {
        /* already detached */
      }
    }
    removeFile(staging);
    throw error;
  }
};

const dropIndexesFrom = (appDb) => {
  appDb.transaction(() => {
    for (const name of INDEX_TABLES) appDb.exec(`DROP TABLE IF EXISTS "${name}"`);
    if (tablesIn(appDb).has('meta')) {
      appDb.prepare(`DELETE FROM meta WHERE ${INDEX_META} OR key = ?`).run(ATTEMPTS_KEY);
    }
  })();
};

/**
 * Take the indexes out of app.db, carrying them to the cache directory first.
 *
 * Called while app.db is opened, before anything else holds the connection.
 * Idempotent: a database without index tables has nothing to give.
 *
 * app.db keeps its tables until the copy has succeeded. A copy that fails —
 * no room in the cache, say — leaves them there and the next start tries
 * again; meanwhile the indexes fill an index.db of their own, which the next
 * successful copy replaces. After a few starts that all failed, the tables are
 * dropped and the indexes are rebuilt from the files, so that app.db does not
 * carry them forever.
 *
 * When the cache already holds the index, what app.db still has is an older
 * image sharing this /config writing into its own tables, and it is dropped.
 */
const moveIndexesOutOf = (appDb) => {
  const tables = tablesIn(appDb);
  const present = INDEX_TABLES.filter((name) => tables.has(name));
  if (present.length === 0) return { moved: false };

  // A new database's migrations create the tables empty: nothing to carry.
  if (!holdsRows(appDb, tables, ['search_documents', 'folder_size_index'])) {
    dropIndexesFrom(appDb);
    return { moved: true, copied: false };
  }

  const destination = getIndexDbPath();
  const attempts = Number(metaValue(appDb, ATTEMPTS_KEY)) || 0;
  if (cacheHoldsTheIndex(destination, attempts > 0)) {
    dropIndexesFrom(appDb);
    logger.info(
      { destination, tables: present },
      '[DB] Dropped index tables left in app.db; the cache directory already holds the indexes'
    );
    return { moved: true, copied: false };
  }

  const startedAt = Date.now();
  try {
    copyIndexesInto(appDb, destination);
  } catch (error) {
    const failed = attempts + 1;
    if (failed >= MAX_MOVE_ATTEMPTS) {
      dropIndexesFrom(appDb);
      logger.warn(
        { err: error, destination, attempts: failed },
        '[DB] Could not copy the indexes out of app.db at any of the last starts; they will be rebuilt from the files'
      );
      return { moved: true, copied: false, gaveUp: true, error };
    }
    appDb
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(ATTEMPTS_KEY, String(failed));
    logger.warn(
      { err: error, destination, attempt: failed, of: MAX_MOVE_ATTEMPTS },
      '[DB] Could not copy the indexes out of app.db; they stay there, and the next start tries again'
    );
    return { moved: false, error };
  }

  dropIndexesFrom(appDb);
  logger.info(
    { destination, tables: present, durationMs: Date.now() - startedAt },
    '[DB] Moved the search index and folder sizes out of app.db into the cache directory'
  );
  return { moved: true, copied: true };
};

const openFile = (file) => {
  const db = new Database(file);
  try {
    databaseMaintenance.configureStorage(db);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    createIndexSchema(db);
    // A full-text index is only checked when it is first read.
    db.prepare('SELECT rowid FROM search_terms LIMIT 1').all();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

const openIndexDb = async () => {
  // app.db first: opening it is what carries an existing index over, and that
  // has to happen before this file is created empty.
  const appDb = await require('./db').getDb();

  const file = getIndexDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  try {
    db = openFile(file);
  } catch (error) {
    if (!isUnreadable(error)) throw error;
    // Derived data: starting again costs a pass, keeping it costs every search.
    logger.warn(
      { err: error, file },
      '[DB] The index database could not be read; it starts again empty and fills from the files'
    );
    removeFile(file);
    db = openFile(file);
  }

  // The index from now on, unless a copy out of app.db is still to come: then
  // the next successful copy replaces this file.
  if (!metaValue(appDb, ATTEMPTS_KEY)) {
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
      READY_KEY,
      new Date().toISOString()
    );
  }
  databaseMaintenance.convertToIncremental(db);
  return db;
};

/** The index database, opened — and carried out of app.db — on first use. */
const getIndexDb = async () => {
  if (indexDbInstance) return indexDbInstance;
  if (!opening) {
    opening = openIndexDb()
      .then((db) => {
        indexDbInstance = db;
        return db;
      })
      .finally(() => {
        opening = null;
      });
  }
  return opening;
};

const closeIndexDb = () => {
  if (!indexDbInstance) return;
  indexDbInstance.close();
  indexDbInstance = null;
};

module.exports = {
  MAX_MOVE_ATTEMPTS,
  getIndexDb,
  getIndexDbPath,
  closeIndexDb,
  moveIndexesOutOf,
};
