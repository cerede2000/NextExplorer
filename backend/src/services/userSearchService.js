/**
 * User Search Service for Collabora @ mentions
 *
 * Searches local SQLite database for users who have logged in.
 *
 * Note: OIDC/OAuth2 does not define a standard user search API.
 * Users must log in at least once to appear in @ mention suggestions.
 */

const { getDb } = require('./db');
const logger = require('../utils/logger');

/**
 * Search users in local SQLite database
 * @param {string} query - Search term
 * @param {number} limit - Max results
 * @returns {Promise<Array<{UserId: string, UserFriendlyName: string, UserEmail: string}>>}
 */
const searchLocalUsers = async (query, limit = 10) => {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  try {
    const db = await getDb();
    const searchPattern = `%${query}%`;

    const rows = db
      .prepare(
        `
      SELECT id, email, username, display_name
      FROM users
      WHERE 
        display_name LIKE ? COLLATE NOCASE OR
        email LIKE ? COLLATE NOCASE OR
        username LIKE ? COLLATE NOCASE
      ORDER BY 
        CASE 
          WHEN display_name LIKE ? COLLATE NOCASE THEN 0
          WHEN username LIKE ? COLLATE NOCASE THEN 1
          ELSE 2
        END,
        display_name ASC,
        email ASC
      LIMIT ?
    `
      )
      .all(searchPattern, searchPattern, searchPattern, `${query}%`, `${query}%`, limit);

    return rows.map((row) => ({
      UserId: row.id,
      UserFriendlyName: row.display_name || row.username || row.email || 'Unknown',
      UserEmail: row.email || '',
    }));
  } catch (err) {
    logger.error({ err }, '[UserSearch] Error searching local users');
    return [];
  }
};

/**
 * Search users for Collabora @ mentions
 *
 * Searches the local database for users who have logged in at least once.
 *
 * @param {string} query - Search term (partial name/email)
 * @param {number} limit - Max results to return
 * @returns {Promise<{Users: Array<{UserId: string, UserFriendlyName: string, UserEmail: string}>}>}
 */
const searchUsersForMentions = async (query, limit = 10) => {
  if (!query || typeof query !== 'string' || query.trim().length < 1) {
    return { Users: [] };
  }

  const trimmedQuery = query.trim();
  const users = await searchLocalUsers(trimmedQuery, limit);

  logger.debug(`[UserSearch] Query="${trimmedQuery}" found ${users.length} users`);

  return { Users: users };
};

/**
 * Everyone who can be mentioned, without a search term.
 *
 * ONLYOFFICE asks for the list once and filters it in the editor as the comment
 * is typed, so there is nothing to search on here — which is why this cannot go
 * through `searchLocalUsers`, whose pattern match is what makes it safe to run
 * on user input in the first place. Bounded by `limit` for the same reason a
 * search is: an unbounded list is a mistake waiting for a large deployment.
 */
const listUsersForMentions = async (limit = 100) => {
  try {
    const db = await getDb();
    const rows = db
      .prepare(
        `
      SELECT id, email, username, display_name
      FROM users
      ORDER BY display_name ASC, email ASC
      LIMIT ?
    `
      )
      .all(limit);

    return rows.map((row) => ({
      id: String(row.id),
      name: row.display_name || row.username || row.email || 'Unknown',
      email: row.email || '',
    }));
  } catch (err) {
    logger.error({ err }, '[UserSearch] Error listing users for mentions');
    return [];
  }
};

module.exports = {
  searchUsersForMentions,
  searchLocalUsers,
  listUsersForMentions,
};
