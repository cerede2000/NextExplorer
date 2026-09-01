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
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_search_documents_path ON search_documents(path);

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

/** Apply the schema. Safe to call on every start. */
const ensureSchema = (db) => {
  db.exec(SEARCH_INDEX_DDL);
};

/** What the index believes about a path, or null. */
const getIndexedDocument = (db, path) =>
  prep(db, 'SELECT id, mtime_ms AS mtimeMs, size FROM search_documents WHERE path = ?').get(
    path
  ) || null;

/** Whether the file on disk is the one already indexed. */
const isUpToDate = (indexed, { mtimeMs, size }) =>
  Boolean(indexed) && indexed.mtimeMs === Math.floor(mtimeMs) && indexed.size === size;

/**
 * Put a document's words in the index, replacing whatever was there.
 * Both tables move together or not at all.
 */
const upsertDocument = (db, { path, mtimeMs, size, text }) => {
  const now = new Date().toISOString();
  const existing = getIndexedDocument(db, path);

  if (existing) {
    prep(db, 'DELETE FROM search_terms WHERE rowid = ?').run(existing.id);
    prep(
      db,
      'UPDATE search_documents SET mtime_ms = ?, size = ?, indexed_at = ? WHERE id = ?'
    ).run(Math.floor(mtimeMs), size, now, existing.id);
    prep(db, 'INSERT INTO search_terms(rowid, text) VALUES (?, ?)').run(existing.id, text);
    return existing.id;
  }

  const result = prep(
    db,
    'INSERT INTO search_documents (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)'
  ).run(path, Math.floor(mtimeMs), size, now);
  prep(db, 'INSERT INTO search_terms(rowid, text) VALUES (?, ?)').run(
    result.lastInsertRowid,
    text
  );
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
       SET path = ? || substr(path, ?)
       WHERE path LIKE ? ESCAPE '\\'`
  ).run(toPath, fromPath.length + 1, like);

  const movedSelf = prep(db, 'UPDATE search_documents SET path = ? WHERE path = ?').run(
    toPath,
    fromPath
  );

  return moved.changes + movedSelf.changes;
};

/**
 * Paths whose words match, best first.
 *
 * The query is what FTS5 understands, so a bare word is a prefix-free term
 * match. Callers pass a term the user typed, so it is quoted: someone
 * searching `NOT` or `a-b` is looking for those characters, not writing an
 * expression.
 */
const search = (db, term, limit = 100) => {
  const quoted = `"${String(term).replace(/"/g, '""')}"`;
  try {
    return prep(
      db,
      `SELECT d.path AS path
         FROM search_terms t
         JOIN search_documents d ON d.id = t.rowid
         WHERE search_terms MATCH ?
         ORDER BY rank
         LIMIT ?`
    )
      .all(quoted, limit)
      .map((row) => row.path);
  } catch (error) {
    logger.debug({ err: error, term }, 'Full-text query failed');
    return [];
  }
};

/** How much is in there, for the diagnostics page and for tests. */
const stats = (db) => {
  const row = prep(db, 'SELECT COUNT(*) AS documents FROM search_documents').get();
  return { documents: row?.documents ?? 0 };
};

module.exports = {
  SEARCH_INDEX_DDL,
  ensureSchema,
  getIndexedDocument,
  isUpToDate,
  upsertDocument,
  removeDocument,
  removeUnder,
  movePath,
  search,
  stats,
};
