const crypto = require('crypto');

const { getDb } = require('./db');
const logger = require('../utils/logger');

/**
 * The identity the Document Server files a document under.
 *
 * Two people editing the same document only see each other when they were given
 * the same key: the Document Server treats a different key as a different
 * document, and opens a second, independent session on the same file. Whoever
 * saves last then overwrites the other, with nothing to warn either of them.
 *
 * The key therefore has to stay the same for as long as anyone has the document
 * open — including across the saves those editors are making, which change the
 * file and would otherwise change the key. It has to change afterwards, because
 * the Document Server caches the prepared document under that key alone and
 * would serve the stale copy on the next open.
 *
 * So: keyed on the file's identity, remembered while the document is in use, and
 * dropped when the Document Server reports it has let go.
 */

// Long enough to cover an editing session, short enough that a key abandoned by
// a crashed browser does not outlive the day.
const KEY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * What makes this file, opened with this editor, the document it is.
 *
 * Unchanged from the original inline computation, deliberately: it is what makes
 * a key differ after an external replacement, and after opening the same bytes
 * with a different editor — a drawing once opened as text kept answering from
 * cache long after the mapping was corrected.
 */
const buildSignature = (relativePath, stat, documentType) =>
  crypto
    .createHash('sha256')
    .update(relativePath)
    .update(String(stat.mtimeMs))
    .update(String(stat.ctimeMs))
    .update(String(stat.size))
    .update(String(documentType))
    .digest('hex');

const nowIso = () => new Date().toISOString();
const expiryIso = () => new Date(Date.now() + KEY_TTL_MS).toISOString();

/**
 * The key to hand this editor.
 *
 * `inUse` says whether anyone currently has the document open. It is what
 * separates "the file changed because we are editing it" from "the file changed
 * while nobody was looking": the first must keep the key, the second must not.
 */
const resolveDocumentKey = async ({ relativePath, stat, documentType, inUse }) => {
  const signature = buildSignature(relativePath, stat, documentType);

  let db;
  try {
    db = await getDb();
  } catch (error) {
    // A key that cannot be remembered is still better than no editor at all:
    // fall back to the signature, which is what this used to be.
    logger.warn({ err: error, path: relativePath }, 'ONLYOFFICE key store unavailable');
    return signature;
  }

  const existing = db
    .prepare(
      'SELECT document_key, signature, expires_at FROM onlyoffice_document_keys WHERE relative_path = ?'
    )
    .get(relativePath);

  if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
    // Same file, same editor: nothing has happened that the Document Server's
    // cache needs to hear about.
    if (existing.signature === signature) {
      db.prepare('UPDATE onlyoffice_document_keys SET expires_at = ? WHERE relative_path = ?').run(
        expiryIso(),
        relativePath
      );
      return existing.document_key;
    }

    // The file changed under an open document. That is what a save looks like
    // from here, so keep the key and let the editors carry on together.
    if (inUse) {
      db.prepare(
        'UPDATE onlyoffice_document_keys SET signature = ?, expires_at = ? WHERE relative_path = ?'
      ).run(signature, expiryIso(), relativePath);
      return existing.document_key;
    }
  }

  // Nobody holds it and it is not what it was: a fresh identity, so the
  // Document Server fetches the document again instead of serving its cache.
  db.prepare(
    `INSERT INTO onlyoffice_document_keys (relative_path, document_key, signature, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(relative_path) DO UPDATE SET
       document_key = excluded.document_key,
       signature = excluded.signature,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`
  ).run(relativePath, signature, signature, nowIso(), expiryIso());

  return signature;
};

/**
 * Forget the key for a document the Document Server has released.
 *
 * Called on its terminal callback. The next open then mints a new key, which is
 * what makes the editor fetch the saved document rather than the copy it still
 * has cached.
 */
const releaseDocumentKey = async (relativePath) => {
  if (!relativePath) return;
  try {
    const db = await getDb();
    db.prepare('DELETE FROM onlyoffice_document_keys WHERE relative_path = ?').run(relativePath);
  } catch (error) {
    logger.warn({ err: error, path: relativePath }, 'ONLYOFFICE key could not be released');
  }
};

/**
 * Follow a document renamed while open, so the editors keep their shared key.
 */
const renameDocumentKey = async ({ from, to }) => {
  if (!from || !to) return;
  try {
    const db = await getDb();
    db.prepare('DELETE FROM onlyoffice_document_keys WHERE relative_path = ?').run(to);
    db.prepare('UPDATE onlyoffice_document_keys SET relative_path = ? WHERE relative_path = ?').run(
      to,
      from
    );
  } catch (error) {
    logger.warn({ err: error, from, to }, 'ONLYOFFICE key could not follow the rename');
  }
};

module.exports = {
  buildSignature,
  resolveDocumentKey,
  releaseDocumentKey,
  renameDocumentKey,
};
