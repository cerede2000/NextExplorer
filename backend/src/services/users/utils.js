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

module.exports = {
  nowIso,
  toClientUser,
  generateId,
  normalizeEmail,
  toShareableUser,
};
