const { generateId, nowIso } = require('../../utils/ids');

const toClientUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    username: row.username,
    displayName: row.display_name || null,
    roles: (() => {
      try {
        return JSON.parse(row.roles || '[]');
      } catch {
        return [];
      }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The folder this account owns, claimed once rather than derived per
    // request — two accounts can otherwise derive the same one.
    personalFolderName: row.personal_folder_name || null,
  };
};

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const toShareableUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name || null,
  };
};

/**
 * Whether a username is already answering for another account.
 *
 * Compared without regard to case, because that is how it is matched at sign
 * in: allowing `Alice` alongside `alice` would create a name that identifies
 * two accounts and therefore signs nobody in.
 *
 * @param {object} db open database
 * @param {string} username the name being claimed
 * @param {string|null} exceptUserId the account claiming it, when it already exists
 */
const usernameTaken = (db, username, exceptUserId = null) => {
  const trimmed = typeof username === 'string' ? username.trim() : '';
  if (!trimmed) return false;

  const row = db
    .prepare(
      `SELECT id FROM users
       WHERE username IS NOT NULL AND lower(username) = lower(?) AND id <> COALESCE(?, '')`
    )
    .get(trimmed, exceptUserId);
  return Boolean(row);
};

module.exports = {
  nowIso,
  toClientUser,
  generateId,
  normalizeEmail,
  toShareableUser,
  usernameTaken,
};
