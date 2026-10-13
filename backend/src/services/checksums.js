const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');

const { getIndexDb } = require('./indexDb');
const logger = require('../utils/logger');

/**
 * What a file's bytes add up to, computed once and remembered.
 *
 * Somebody who downloaded a file somewhere else has a checksum written on the
 * page they took it from, and the only way to know they have the same bytes is
 * to take their own. It is also how two copies of a photo library are told
 * apart when the dates and the sizes agree and the contents may not.
 *
 * Three digests, in one pass over the file. MD5 and SHA-1 are not sound against
 * an adversary any more, and both are still what most pages publish, so leaving
 * them out would mean reading a forty-gigabyte film and still not being able to
 * answer the question that was asked. Reading it three times to answer it would
 * be worse: the cost here is the read, not the arithmetic.
 *
 * Remembering is the other half. A hash is only worth having once, and a file
 * of that size is not something to read again because a panel was reopened.
 *
 * Which is where the one real trap is. A remembered hash of a file that has
 * since changed is worse than no hash at all: it answers confidently and it
 * answers wrong. Clearing it wherever the application writes — the editor,
 * ONLYOFFICE, a version restored, an upload — is the version of this that
 * cannot be made to hold, because the writer that gets forgotten is the one
 * nobody thinks of, and nothing would say so. So the file's state is the key
 * rather than a thing to maintain: its size, when it was last changed, its
 * inode and when that inode was made. A file that changed does not match its
 * row — the row is dropped where it is found, and the bytes are read again.
 * There is nothing to forget to clean, including after a write this
 * application knew nothing about, over SMB or from a shell.
 */

/** In one pass, because the cost is the read. */
const ALGORITHMS = ['md5', 'sha1', 'sha256'];

/**
 * Keyed by where the file is on the disk, not by the name a reader gave it.
 *
 * Two accounts each have a `personal/notes.txt`, and two people can be given
 * volumes they both call `Mine`: a logical path is one person's name for a
 * file, and as a key it puts two files in one row. The absolute path is the
 * file, which is also what a deletion and a move already hold — so the rows
 * can follow one and go with the other.
 */
const CHECKSUMS_DDL = `
  CREATE TABLE IF NOT EXISTS file_checksums (
    absolute_path TEXT PRIMARY KEY,
    identity      TEXT NOT NULL,
    digests       TEXT NOT NULL,
    computed_at   DATETIME NOT NULL
  );
`;

/**
 * What tells one state of a file from another.
 *
 * Not the inode on its own: a filesystem hands a deleted one straight back, so
 * `dev:ino` alone says two different files are the same (nxzai/NextExplorer —
 * the same trap the version index met). With the size, the time it was last
 * changed and the time the inode was made, a file that changed at all has a
 * different key, and a key that matches is the same bytes on any filesystem
 * worth the name.
 */
const identityOf = (stats) =>
  [stats.size, Math.trunc(stats.mtimeMs), stats.ino || 0, Math.trunc(stats.birthtimeMs || 0)].join(
    ':'
  );

const prepared = new WeakMap();
const prep = (db, sql) => {
  let bySql = prepared.get(db);
  if (!bySql) {
    bySql = new Map();
    prepared.set(db, bySql);
  }
  let statement = bySql.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    bySql.set(sql, statement);
  }
  return statement;
};

const withDb = async (run) => {
  try {
    const db = await getIndexDb();
    db.exec(CHECKSUMS_DDL);
    return run(db);
  } catch (error) {
    // A cache is never a reason to fail: without it the bytes are read again.
    logger.debug({ err: error }, 'The checksum cache could not be reached');
    return null;
  }
};

/**
 * What was computed for this file, if it is still this file.
 *
 * A row that does not match the file in front of it describes bytes that are
 * gone, so it goes: the next computation writes the one that belongs.
 */
const remembered = async ({ absolutePath, stats }) =>
  withDb((db) => {
    const row = prep(
      db,
      'SELECT identity, digests, computed_at FROM file_checksums WHERE absolute_path = ?'
    ).get(absolutePath);
    if (!row) return null;
    if (row.identity !== identityOf(stats)) {
      prep(db, 'DELETE FROM file_checksums WHERE absolute_path = ?').run(absolutePath);
      return null;
    }
    try {
      return { digests: JSON.parse(row.digests), computedAt: row.computed_at };
    } catch {
      return null;
    }
  });

const remember = async ({ absolutePath, stats, digests }) =>
  withDb((db) =>
    prep(
      db,
      `INSERT INTO file_checksums (absolute_path, identity, digests, computed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(absolute_path) DO UPDATE SET
         identity = excluded.identity,
         digests = excluded.digests,
         computed_at = excluded.computed_at`
    ).run(absolutePath, identityOf(stats), JSON.stringify(digests), new Date().toISOString())
  );

/**
 * Forget what was remembered about a path, and about everything under it.
 *
 * Housekeeping rather than correctness: a row describing a file that is gone
 * can never match anything again, and the key is what keeps a stale answer from
 * ever being given. This is so the table does not keep a line for every file
 * anybody ever deleted.
 */
const forget = async (absolutePath) =>
  withDb((db) =>
    prep(db, 'DELETE FROM file_checksums WHERE absolute_path = ? OR absolute_path LIKE ?').run(
      absolutePath,
      `${absolutePath}/%`
    )
  );

/**
 * The same bytes under another name.
 *
 * A move changes nothing about the content, so the digests still hold: they
 * follow the file rather than being thrown away and read again. Children come
 * too, for a folder that moved.
 */
const moved = async (fromAbsolutePath, toAbsolutePath) =>
  withDb((db) => {
    db.transaction(() => {
      prep(db, 'DELETE FROM file_checksums WHERE absolute_path = ?').run(toAbsolutePath);
      prep(db, 'UPDATE file_checksums SET absolute_path = ? WHERE absolute_path = ?').run(
        toAbsolutePath,
        fromAbsolutePath
      );
      prep(
        db,
        `UPDATE OR REPLACE file_checksums
           SET absolute_path = ? || substr(absolute_path, ?)
         WHERE absolute_path LIKE ?`
      ).run(toAbsolutePath, fromAbsolutePath.length + 1, `${fromAbsolutePath}/%`);
    })();
  });

/**
 * Read the file once and answer every digest of it.
 *
 * Cancellable, because this is minutes of reading on a large file and the
 * reader who asked may have changed their mind; and it reports as it goes, for
 * the same reason.
 */
const compute = (absolutePath, { signal, onProgress } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const stopped = new Error('Operation cancelled.');
      stopped.code = 'OPERATION_CANCELLED';
      reject(stopped);
      return;
    }

    const hashes = ALGORITHMS.map((algorithm) => [algorithm, crypto.createHash(algorithm)]);
    const stream = fs.createReadStream(absolutePath);
    let read = 0;

    const stop = () => {
      stream.destroy();
      const stopped = new Error('Operation cancelled.');
      stopped.code = 'OPERATION_CANCELLED';
      reject(stopped);
    };
    signal?.addEventListener('abort', stop, { once: true });

    stream.on('data', (chunk) => {
      for (const [, hash] of hashes) hash.update(chunk);
      read += chunk.length;
      onProgress?.(read);
    });
    stream.on('error', (error) => {
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', stop);
      resolve(
        Object.fromEntries(hashes.map(([algorithm, hash]) => [algorithm, hash.digest('hex')]))
      );
    });
  });

/**
 * The digests of one file: the ones already known, or the ones its bytes give.
 *
 * `onProgress` is called with the bytes read so far, and only while they are
 * being read — a remembered answer reports nothing because it costs nothing.
 */
const digestsOf = async ({ absolutePath, signal, onProgress }) => {
  const stats = await fsp.stat(absolutePath);
  const known = await remembered({ absolutePath, stats });
  if (known) return { ...known, size: stats.size, fromCache: true };

  const digests = await compute(absolutePath, { signal, onProgress });
  // Read again rather than trusted: a file written while it was being read has
  // digests of something that no longer exists, and remembering those is the
  // one thing this must never do.
  const after = await fsp.stat(absolutePath);
  if (identityOf(after) !== identityOf(stats)) {
    return { digests, size: after.size, fromCache: false, changedWhileReading: true };
  }

  await remember({ absolutePath, stats, digests });
  return { digests, size: stats.size, computedAt: new Date().toISOString(), fromCache: false };
};

module.exports = {
  ALGORITHMS,
  CHECKSUMS_DDL,
  identityOf,
  remembered,
  remember,
  forget,
  moved,
  compute,
  digestsOf,
};
