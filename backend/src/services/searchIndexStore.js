const logger = require('../utils/logger');

/**
 * Where the words are kept, and nothing else.
 *
 * The index stores terms, not text. FTS5's contentless mode keeps only what it
 * needs to answer a query, which is a fraction of the size of the documents —
 * and the matched line, which results show, is read back from the file when a
 * result is actually returned. The path is right there, and only a page of
 * results is ever read, so storing every document a second time to save that
 * would be paying a lot for very little.
 *
 * `contentless_delete=1` is what makes it maintainable: without it, removing a
 * row requires handing FTS5 the original text back, which is exactly what is
 * not kept. It needs SQLite 3.43 or newer; the bundled one is well past that.
 */

const SEARCH_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS search_documents (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL DEFAULT '',
    -- The file's own name, composed and lowercased, so that looking one up is
    -- a scan over short strings instead of a walk over the storage. It is kept
    -- rather than derived because neither folding nor composition exists in
    -- SQL, and they are what make the two spellings of an accent one word.
    name_fold TEXT NOT NULL DEFAULT '',
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_search_documents_path ON search_documents(path);
  -- Asking what a folder holds has to be a lookup rather than a scan: it is
  -- what lets a pass forget a directory as soon as it leaves it, instead of
  -- carrying every path it has ever seen to the end.
  CREATE INDEX IF NOT EXISTS idx_search_documents_dir ON search_documents(dir);

  CREATE VIRTUAL TABLE IF NOT EXISTS search_terms
    USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`;

/**
 * Prepared-statement cache, keyed by the db handle then the SQL text.
 *
 * Preparing a statement compiles it. A reconcile over a large volume runs these
 * queries several times per document and hundreds of times per second, and
 * compiling each one again every time burns CPU and churns native handles for
 * nothing. The folder-size index learned this on the same scale; this is the
 * same cache. The WeakMap lets it be collected with its connection.
 */
const stmtCache = new WeakMap();
const prep = (db, sql) => {
  let bySql = stmtCache.get(db);
  if (!bySql) {
    bySql = new Map();
    stmtCache.set(db, bySql);
  }
  let stmt = bySql.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    bySql.set(sql, stmt);
  }
  return stmt;
};

/**
 * A name as the catalogue holds it: composed, then lowercased.
 *
 * The same two steps the typed term goes through, so that the comparison is
 * between like and like. Doing it once at index time rather than at every
 * query is the whole point of storing it.
 */
const foldName = (documentPath) => {
  const at = String(documentPath).lastIndexOf('/');
  const name = at === -1 ? String(documentPath) : String(documentPath).slice(at + 1);
  return name.normalize('NFC').toLowerCase();
};

/**
 * Bring a database written before names were kept up to date with one that
 * keeps them.
 *
 * The column is added and then filled from the paths already stored — no file
 * is opened, because a name is the one thing a path already tells us. Rows
 * arriving later are filled as they are written.
 */
const ensureNameColumn = (db) => {
  const columns = db.prepare('PRAGMA table_info(search_documents)').all();
  if (!columns.some((column) => column.name === 'name_fold')) {
    db.exec("ALTER TABLE search_documents ADD COLUMN name_fold TEXT NOT NULL DEFAULT ''");
  }

  const pending = db.prepare("SELECT id, path FROM search_documents WHERE name_fold = ''");
  const setName = db.prepare('UPDATE search_documents SET name_fold = ? WHERE id = ?');
  const fill = db.transaction((rows) => {
    for (const row of rows) setName.run(foldName(row.path), row.id);
  });

  let filled = 0;
  for (;;) {
    const rows = pending.all().slice(0, 5000);
    if (!rows.length) break;
    fill(rows);
    filled += rows.length;
  }
  return filled;
};

/** What the index believes about a path, or null. */
const getIndexedDocument = (db, path) =>
  prep(db, 'SELECT id, mtime_ms AS mtimeMs, size FROM search_documents WHERE path = ?').get(path) ||
  null;

/** Whether the file on disk is the one already indexed. */
const isUpToDate = (indexed, { mtimeMs, size }) =>
  Boolean(indexed) && indexed.mtimeMs === Math.floor(mtimeMs) && indexed.size === size;

/**
 * Put a document's words in the index, replacing whatever was there.
 * Both tables move together or not at all.
 */
const parentOf = (documentPath) => {
  const at = documentPath.lastIndexOf('/');
  return at === -1 ? '' : documentPath.slice(0, at);
};

const upsertDocument = (db, { path, mtimeMs, size, text }) => {
  const now = new Date().toISOString();
  const existing = getIndexedDocument(db, path);
  // A row is the file; terms are what it happens to say. A photograph has a
  // name and no words, and it belongs in here for the first of those: a name
  // search that has to walk the storage is a name search that does not finish
  // on a network share.
  const hasText = typeof text === 'string' && text.trim() !== '';

  if (existing) {
    prep(db, 'DELETE FROM search_terms WHERE rowid = ?').run(existing.id);
    prep(
      db,
      `UPDATE search_documents
          SET dir = ?, name_fold = ?, mtime_ms = ?, size = ?, indexed_at = ?
        WHERE id = ?`
    ).run(parentOf(path), foldName(path), Math.floor(mtimeMs), size, now, existing.id);
    if (hasText) {
      prep(db, 'INSERT INTO search_terms(rowid, text) VALUES (?, ?)').run(existing.id, text);
    }
    return existing.id;
  }

  const result = prep(
    db,
    `INSERT INTO search_documents (path, dir, name_fold, mtime_ms, size, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(path, parentOf(path), foldName(path), Math.floor(mtimeMs), size, now);
  if (hasText) {
    prep(db, 'INSERT INTO search_terms(rowid, text) VALUES (?, ?)').run(
      result.lastInsertRowid,
      text
    );
  }
  return result.lastInsertRowid;
};

/** Forget a document. */
const removeDocument = (db, path) => {
  const existing = getIndexedDocument(db, path);
  if (!existing) return false;

  prep(db, 'DELETE FROM search_terms WHERE rowid = ?').run(existing.id);
  prep(db, 'DELETE FROM search_documents WHERE id = ?').run(existing.id);
  return true;
};

/** Forget a folder and everything under it. Answers how many went. */
const removeUnder = (db, prefix) => {
  const rows = prep(
    db,
    'SELECT id FROM search_documents WHERE path = ? OR path LIKE ? ESCAPE ?'
  ).all(prefix, `${prefix.replace(/[\\%_]/g, '\\$&')}/%`, '\\');

  for (const row of rows) {
    prep(db, 'DELETE FROM search_terms WHERE rowid = ?').run(row.id);
    prep(db, 'DELETE FROM search_documents WHERE id = ?').run(row.id);
  }
  return rows.length;
};

/**
 * Follow a rename. The words do not change, so only the path does — which is
 * the whole reason a move is cheap and a rewrite is not.
 */
const movePath = (db, fromPath, toPath) => {
  const like = `${fromPath.replace(/[\\%_]/g, '\\$&')}/%`;
  const moved = prep(
    db,
    `UPDATE search_documents
       SET path = ? || substr(path, ?),
           dir = rtrim(? || substr(path, ?), replace(? || substr(path, ?), rtrim(? || substr(path, ?), replace(? || substr(path, ?), '/', '')), ''))
       WHERE path LIKE ? ESCAPE '\\'`
  ).run(
    toPath,
    fromPath.length + 1,
    toPath,
    fromPath.length + 1,
    toPath,
    fromPath.length + 1,
    toPath,
    fromPath.length + 1,
    toPath,
    fromPath.length + 1,
    like
  );

  // Only the moved node can have been renamed: everything under it keeps the
  // name it had, and only its prefix moved.
  const movedSelf = prep(
    db,
    'UPDATE search_documents SET path = ?, dir = ?, name_fold = ? WHERE path = ?'
  ).run(toPath, parentOf(toPath), foldName(toPath), fromPath);

  return moved.changes + movedSelf.changes;
};

/**
 * Paths whose words match, best first, with the score that put them there.
 *
 * FTS5 answers with a negative number and smaller is better, which is why
 * `ORDER BY rank` reads the right way round. The score comes back because a
 * caller has to be able to tell a document that genuinely answers better from
 * one that merely came first: on a folder of exports sharing a boilerplate
 * line, every score is the same and the order was whatever the index felt
 * like.
 *
 * The query is what FTS5 understands, so a bare word is a prefix-free term
 * match. Callers pass a term the user typed, so it is quoted: someone
 * searching `NOT` or `a-b` is looking for those characters, not writing an
 * expression.
 */
const searchRanked = (db, term, limit = 100) => {
  const quoted = `"${String(term).replace(/"/g, '""')}"`;
  try {
    return prep(
      db,
      `SELECT d.path AS path, rank AS score
         FROM search_terms t
         JOIN search_documents d ON d.id = t.rowid
         WHERE search_terms MATCH ?
         ORDER BY rank
         LIMIT ?`
    ).all(quoted, limit);
  } catch (error) {
    logger.debug({ err: error, term }, 'Full-text query failed');
    return [];
  }
};

/** The same, when only the paths are wanted. */
const search = (db, term, limit = 100) => searchRanked(db, term, limit).map((row) => row.path);

/**
 * Candidate paths for a name search, streamed rather than collected.
 *
 * SQL narrows; the caller decides. The term the user typed has rules — the
 * last segment only, two spellings of an accent being one word, a pattern
 * anchored on the whole name — and those live in one place, in the matcher.
 * Teaching SQLite a second version of them is how the two drift apart, so this
 * hands back everything that could match and lets that one matcher say.
 *
 * `literal` is the narrowing: the longest run of ordinary characters in the
 * term. For a typed word it is the word itself, and the scan stops at the rows
 * that hold it; for a pattern like `*.log` it is `.log`. Without one the scan
 * is the whole catalogue, which at half a million rows is about forty
 * milliseconds — against a walk of the storage, which on a network share is
 * the reason this exists.
 *
 * Streamed because a common word matches tens of thousands of rows and the
 * caller wants a hundred: materialising the rest is work nobody asked for.
 */
const iterateNameCandidates = (db, { base = '', literal = '' } = {}) => {
  const where = [];
  const params = [];

  if (base) {
    // The folder and everything under it, through the dir index: '/' is 0x2F
    // and '0' is 0x30, so the range holds every path that starts with `base/`
    // and nothing that merely starts with the same letters.
    where.push('(dir = ? OR (dir > ? AND dir < ?))');
    params.push(base, `${base}/`, `${base}0`);
  }

  if (literal) {
    where.push("name_fold LIKE ? ESCAPE '\\'");
    params.push(`%${literal.replace(/[\\%_]/g, '\\$&')}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return prep(db, `SELECT path FROM search_documents ${clause}`)
    .pluck()
    .iterate(...params);
};

/**
 * Folders whose path could hold a matching segment, streamed.
 *
 * A separate question from the one above, and it has to be: a folder called
 * `build` is a match for `build` while nothing inside it is, so the rows for
 * its files narrow it away. This asks the directory column instead, and hands
 * every candidate to the same matcher, which takes the path apart segment by
 * segment and decides.
 */
const iterateDirCandidates = (db, { base = '', literal = '' } = {}) => {
  const where = [];
  const params = [];

  if (base) {
    where.push('(dir > ? AND dir < ?)');
    params.push(`${base}/`, `${base}0`);
  }

  if (literal) {
    where.push("dir LIKE ? ESCAPE '\\'");
    params.push(`%${literal.replace(/[\\%_]/g, '\\$&')}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return prep(db, `SELECT DISTINCT dir FROM search_documents ${clause}`)
    .pluck()
    .iterate(...params);
};

/**
 * What a folder holds, by name, and nothing about what is under it.
 *
 * This is the query that replaced carrying every path seen so far in memory:
 * fifty megabytes for two hundred thousand files, held from the first
 * directory to the last, on a container whose whole working set is sixty.
 */
const listDirectoryPaths = (db, dir) =>
  prep(db, 'SELECT path FROM search_documents WHERE dir = ?').pluck().all(dir);

/** Every folder the index has something in. Streamed, never materialised. */
const iterateIndexedDirectories = (db) =>
  prep(db, 'SELECT DISTINCT dir FROM search_documents ORDER BY dir').pluck().iterate();

/**
 * Whether the index has ever been finished.
 *
 * It matters because the index does not supplement the live content search, it
 * replaces it. Half an index therefore answers half a search and says nothing
 * about the half it did not look at — a term that was found yesterday is simply
 * absent today, which is worse than a slow answer and much harder to explain.
 * Until a pass has run to the end, searches read the tree as they always did.
 *
 * Kept in the database rather than in memory because a restart does not
 * invalidate the index: what was read is still read, and the mtime check is
 * what decides whether it is still true.
 */
const READY_KEY = 'search_index_complete_at';

/**
 * Which shape the finished index has.
 *
 * A pass that ran before names were kept left an index holding only the
 * documents with words in them, which answers a content search correctly and a
 * name search with silence. The two are therefore asked separately: the flag
 * above says a pass finished, this says what that pass was able to record.
 * Raising the number is how a later change says the catalogue has to be made
 * again without throwing away the terms.
 */
const CATALOGUE_KEY = 'search_index_catalogue_version';
const CATALOGUE_VERSION = '1';

const markPassComplete = (db, at = new Date().toISOString()) => {
  const write = prep(db, 'INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
  write.run(READY_KEY, at);
  write.run(CATALOGUE_KEY, CATALOGUE_VERSION);
};

/** Whether a finished pass catalogued every file, and not only the wordy ones. */
const hasNameCatalogue = (db) => {
  try {
    if (!isReady(db)) return false;
    return (
      prep(db, 'SELECT value FROM meta WHERE key = ?').pluck().get(CATALOGUE_KEY) ===
      CATALOGUE_VERSION
    );
  } catch {
    return false;
  }
};

const isReady = (db) => {
  try {
    return Boolean(prep(db, 'SELECT value FROM meta WHERE key = ?').pluck().get(READY_KEY));
  } catch {
    return false;
  }
};

/**
 * Throw the whole index away.
 *
 * Safe at any time: every row in it was read from a file that is still there,
 * so the only cost of being wrong about needing this is one pass.
 */
const clear = (db) => {
  db.exec('DELETE FROM search_terms');
  db.exec('DELETE FROM search_documents');
  prep(db, 'DELETE FROM meta WHERE key = ?').run(READY_KEY);
  prep(db, 'DELETE FROM meta WHERE key = ?').run(CATALOGUE_KEY);
};

/** How much is in there, for the diagnostics page and for tests. */
/**
 * What is in there, counted two ways.
 *
 * `files` is the catalogue — one row each, which is what a name search reads.
 * `documents` is how many of those had words worth keeping, which is what a
 * content search reads. They were the same number while only wordy files were
 * recorded; reporting one for the other now would tell an administrator that
 * their photographs are full-text indexed.
 */
const stats = (db) => {
  const files = prep(db, 'SELECT COUNT(*) AS n FROM search_documents').get()?.n ?? 0;
  const documents = prep(db, 'SELECT COUNT(*) AS n FROM search_terms').get()?.n ?? 0;
  return { files, documents };
};

module.exports = {
  SEARCH_INDEX_DDL,
  foldName,
  ensureNameColumn,
  iterateNameCandidates,
  iterateDirCandidates,
  hasNameCatalogue,
  getIndexedDocument,
  isUpToDate,
  upsertDocument,
  removeDocument,
  removeUnder,
  movePath,
  search,
  searchRanked,
  stats,
  clear,
  listDirectoryPaths,
  iterateIndexedDirectories,
  markPassComplete,
  isReady,
};
