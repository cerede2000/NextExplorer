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
// What the indexes record about themselves in `meta`, and nothing else does.
const INDEX_META = "key = 'search_index_complete_at' OR key LIKE 'folder_size_index_version:%'";

let indexDbInstance = null;
let opening = null;

const getIndexDbPath = () => path.join(directories.cache, FILE_NAME);

const tablesIn = (db) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all()
  );

const removeFile = (file) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
};

/**
 * Copy the indexes app.db holds into a file of their own.
 *
 * Copied page for page with VACUUM INTO, then everything that is not an index
 * is dropped from the copy. The full-text index keeps no text, so its rows
 * cannot be read back and inserted again, and SQLite refuses writes into the
 * tables it keeps them in; a copy of the pages is the one way to carry it over
 * as it is, rather than reading the whole volume again to rebuild it.
 *
 * Written beside its destination and renamed into place, so a file named
 * index.db is always a finished one.
 */
const copyIndexesInto = (appDb, destination) => {
  const staging = `${destination}.moving`;
  removeFile(staging);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  try {
    appDb.prepare('VACUUM INTO ?').run(staging);

    const copy = new Database(staging);
    try {
      // better-sqlite3 enforces foreign keys, and dropping a table deletes its
      // rows first: once `users` is gone, dropping a table that points at it
      // fails. Nothing is left in the copy for the keys to protect.
      copy.pragma('foreign_keys = OFF');
      const keep = (name) => INDEX_TABLES.includes(name) || name.startsWith('search_terms_');
      const tables = [...tablesIn(copy)];
      // Triggers and views first: SQLite reads every one of them again when a
      // table goes, and one naming a table already dropped fails the drop.
      const dependents = copy
        .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')")
        .all();
      copy.transaction(() => {
        for (const { type, name } of dependents) {
          copy.exec(`DROP ${type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${name}"`);
        }
        for (const name of tables) {
          if (name !== 'meta' && !keep(name)) copy.exec(`DROP TABLE IF EXISTS "${name}"`);
        }
        if (tables.includes('meta')) copy.exec(`DELETE FROM meta WHERE NOT (${INDEX_META})`);
      })();
      copy.pragma('auto_vacuum = INCREMENTAL');
      copy.exec('VACUUM');
      copy.pragma('journal_mode = WAL');
    } finally {
      copy.close();
    }

    fs.renameSync(staging, destination);
  } catch (error) {
    removeFile(staging);
    throw error;
  }
};

/**
 * Take the indexes out of app.db, carrying them to the cache directory first
 * when nothing is there yet.
 *
 * Called while app.db is opened, before anything else holds the connection.
 * Idempotent: a database without index tables has nothing to give. When the
 * cache already holds an index file, that file is the index — app.db's tables
 * are what an interrupted move, or an older image sharing this /config, left
 * behind — and they are only dropped.
 *
 * A copy that fails leaves app.db exactly as it was. The indexes then start
 * empty in the cache and fill again from the files; nothing but time is lost,
 * and the next start drops what app.db still holds.
 */
const moveIndexesOutOf = (appDb) => {
  const present = INDEX_TABLES.filter((name) => tablesIn(appDb).has(name));
  if (present.length === 0) return { moved: false };

  const destination = getIndexDbPath();
  const startedAt = Date.now();
  let copied = false;

  // A new database's migrations create the tables empty: nothing to carry.
  const holdsSomething = present
    .filter((name) => name !== 'search_terms')
    .some((name) => appDb.prepare(`SELECT EXISTS (SELECT 1 FROM "${name}")`).pluck().get());

  if (holdsSomething && !fs.existsSync(destination)) {
    try {
      copyIndexesInto(appDb, destination);
      copied = true;
    } catch (error) {
      logger.warn(
        { err: error, destination },
        '[DB] Could not copy the indexes out of app.db; they will be rebuilt from the files'
      );
      return { moved: false, error };
    }
  }

  appDb.transaction(() => {
    for (const name of INDEX_TABLES) appDb.exec(`DROP TABLE IF EXISTS "${name}"`);
    if (tablesIn(appDb).has('meta')) appDb.exec(`DELETE FROM meta WHERE ${INDEX_META}`);
  })();

  if (holdsSomething) {
    logger.info(
      { destination, copied, tables: present, durationMs: Date.now() - startedAt },
      copied
        ? '[DB] Moved the search index and folder sizes out of app.db into the cache directory'
        : '[DB] Dropped index tables left in app.db; the cache directory already holds the indexes'
    );
  }
  return { moved: true, copied };
};

const openIndexDb = async () => {
  // app.db first: opening it is what carries an existing index over, and that
  // has to happen before this file is created empty.
  // eslint-disable-next-line global-require
  const { getDb, FOLDER_SIZE_INDEX_DDL } = require('./db');
  await getDb();

  const file = getIndexDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    databaseMaintenance.configureStorage(db);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    logger.warn({ err: error }, '[DB] Failed to configure the index database');
  }
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(SEARCH_INDEX_DDL);
  db.exec(FOLDER_SIZE_INDEX_DDL);
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
  getIndexDb,
  getIndexDbPath,
  closeIndexDb,
  moveIndexesOutOf,
};
