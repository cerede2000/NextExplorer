const path = require('path');
const fs = require('fs/promises');

const { search: searchConfig, directories } = require('../config/index');
const { extractPdfTextLines } = require('./pdfTextExtract');
const { extractOfficeTextLines, isOfficeDocument } = require('./officeTextExtract');
const store = require('./searchIndexStore');

/**
 * Building the index without being noticed.
 *
 * The rule this borrows from the folder-size index: work in small batches
 * inside one transaction each, hand the event loop back between them, and
 * check an abort signal at every step. A walk that cannot be interrupted is a
 * walk that decides for itself when the server is free, and it is always
 * wrong about that.
 *
 * Reading a file is the expensive part, so nothing is read twice: a document
 * whose size and modification time match what was indexed is skipped without
 * being opened.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);

/**
 * How much of one document is worth indexing, and how much may be held at once.
 *
 * A batch used to be counted in documents, which says nothing about memory: a
 * file of a few megabytes becomes a JavaScript string twice that size, and
 * twenty-five of them held together while FTS5 tokenises each is hundreds of
 * megabytes for a background task nobody asked to be noticed. Both are bounded
 * in bytes now.
 *
 * A megabyte of text is some two hundred thousand words. A search that cannot
 * be answered by those is not one a bigger index would have answered either.
 */
const MAX_TEXT_PER_DOCUMENT = 1024 * 1024;
const MAX_TEXT_PER_BATCH = 4 * 1024 * 1024;

/** Enough of a file to tell prose from a binary. */
const looksBinary = (buffer) => {
  const length = Math.min(buffer.length, 4096);
  if (!length) return false;

  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / length > 0.3;
};

/**
 * The words in a file, or null where there are none to take — a binary, an
 * unreadable file, a document with no text layer.
 */
const readIndexableText = async (absolutePath) => {
  if (isOfficeDocument(absolutePath)) {
    const lines = extractOfficeTextLines(absolutePath);
    return lines ? lines.join('\n') : null;
  }

  if (path.extname(absolutePath).toLowerCase() === '.pdf') {
    const lines = await extractPdfTextLines(absolutePath);
    return lines ? lines.join('\n') : null;
  }

  try {
    const buffer = await fs.readFile(absolutePath);
    if (looksBinary(buffer)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
};

/** As much of a document as is worth keeping terms for. */
const capText = (text) =>
  text.length > MAX_TEXT_PER_DOCUMENT ? text.slice(0, MAX_TEXT_PER_DOCUMENT) : text;

const createAbortedError = () => {
  const error = new Error('Indexing was interrupted.');
  error.code = 'SEARCH_INDEX_ABORTED';
  return error;
};

/**
 * Walk a tree and bring the index up to date with it.
 *
 * Returns what it did, and what it did not: an interrupted run reports its
 * progress rather than throwing it away, so the next one is shorter.
 */
const indexTree = async ({
  db,
  rootAbs = directories.volume,
  rootRel = '',
  signal,
  batchSize = 25,
  pauseMs = 50,
  maxFileSizeBytes = searchConfig?.maxFileSizeBytes ?? 5 * 1024 * 1024,
  removeMissing = true,
  onProgress,
  progressMs = 30 * 1000,
} = {}) => {
  const seen = new Set();
  const pending = [];
  let pendingBytes = 0;
  let indexed = 0;
  let skipped = 0;
  let batches = 0;
  let interrupted = false;

  const throwIfAborted = () => {
    if (signal?.aborted) throw createAbortedError();
  };

  // A first pass over a large library takes minutes, and silence for minutes
  // is indistinguishable from nothing happening. Progress is reported on a
  // timer rather than per batch, so the log says how it is going without
  // becoming the noisiest thing in it.
  let lastReport = Date.now();

  const flush = () => {
    if (pending.length === 0) return;

    const batch = pending.splice(0, pending.length);
    pendingBytes = 0;
    db.transaction(() => {
      for (const document of batch) store.upsertDocument(db, document);
    })();
    indexed += batch.length;
    batches += 1;

    if (typeof onProgress === 'function' && Date.now() - lastReport >= progressMs) {
      lastReport = Date.now();
      onProgress({ indexed, skipped, batches });
    }
  };

  const walk = async (dirAbs, dirRel) => {
    throwIfAborted();

    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // A directory we cannot read is not a reason to stop.
    }

    for (const entry of entries) {
      throwIfAborted();

      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = path.join(dirAbs, entry.name);
      const relativePath = dirRel ? `${dirRel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      // eslint-disable-next-line no-await-in-loop
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats) continue;
      if (maxFileSizeBytes && stats.size > maxFileSizeBytes) continue;

      seen.add(relativePath);

      // Already indexed, unchanged: not opened at all. This is what makes the
      // second run cost almost nothing.
      if (store.isUpToDate(store.getIndexedDocument(db, relativePath), stats)) {
        skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const text = await readIndexableText(absolutePath);
      if (text === null || !text.trim()) continue;

      const indexable = capText(text);
      pending.push({
        path: relativePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        text: indexable,
      });
      pendingBytes += indexable.length;

      // Whichever ceiling is reached first. The byte one is what keeps a
      // handful of large documents from being held together.
      if (pending.length >= batchSize || pendingBytes >= MAX_TEXT_PER_BATCH) {
        flush();
        // The pause is the whole point: it is what keeps a full walk from
        // being felt by whoever is using the application meanwhile.
        if (pauseMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(pauseMs);
        }
      }
    }
  };

  try {
    await walk(rootAbs, rootRel);
    flush();
  } catch (error) {
    flush();
    if (error?.code !== 'SEARCH_INDEX_ABORTED') throw error;
    interrupted = true;
  }

  let removed = 0;
  // Only a run that reached the end knows what is missing; an interrupted one
  // would call everything it never got to deleted.
  if (removeMissing && !interrupted) {
    const known = db.prepare('SELECT path FROM search_documents').all();
    const gone = known.filter((row) => !seen.has(row.path));
    if (gone.length > 0) {
      db.transaction(() => {
        for (const row of gone) store.removeDocument(db, row.path);
      })();
      removed = gone.length;
    }
  }

  return { indexed, skipped, removed, batches, interrupted };
};

/** Bring one file up to date, or forget it if it is gone. */
const indexFile = async (db, relativePath, absolutePath) => {
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    store.removeDocument(db, relativePath);
    return { removed: true };
  }

  const maxBytes = searchConfig?.maxFileSizeBytes ?? 0;
  if (maxBytes && stats.size > maxBytes) {
    store.removeDocument(db, relativePath);
    return { skipped: true };
  }

  if (store.isUpToDate(store.getIndexedDocument(db, relativePath), stats)) {
    return { unchanged: true };
  }

  const text = await readIndexableText(absolutePath);
  if (text === null || !text.trim()) {
    store.removeDocument(db, relativePath);
    return { skipped: true };
  }

  store.upsertDocument(db, {
    path: relativePath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    text: capText(text),
  });
  return { indexed: true };
};

module.exports = { indexTree, indexFile, readIndexableText };

// Exported for tests: telling prose from a binary is the one judgement here.
module.exports.looksBinary = looksBinary;
