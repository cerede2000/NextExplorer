const { getDb } = require('../db');
const { auth: envAuthConfig } = require('../../config/index');
const { toClientUser, normalizeEmail } = require('./utils');
const { deriveRolesFromClaims } = require('./oidcAuth');
const { claimPersonalFolderName } = require('../personalFolders');

/**
 * An account that has no folder name yet gets one here.
 *
 * The migration gave every account that existed a name; this covers the ones
 * created since, wherever they were created from, without every creation path
 * having to remember. It writes once in an account's life and reads a column
 * that was already loaded, so the cost after that is a null check.
 */
const withPersonalFolder = (db, row) => {
  if (row && !row.personal_folder_name) {
    row.personal_folder_name = claimPersonalFolderName(db, row);
  }
  return row;
};

const getRequestUser = async (req) => {
  // Synthetic or pre-populated user (e.g., AUTH_ENABLED=false)
  if (req?.user && typeof req.user === 'object' && req.user.id) {
    return req.user;
  }

  /**
   * An API token names one account and nothing else about itself.
   *
   * Read before the session on purpose: a request that presents a token is a
   * token's request, even if a browser cookie happened to ride along with it.
   * The account is loaded fresh on every request, so a role taken away, or an
   * account deleted, applies to the token at once — a token is never more than
   * the account it belongs to, including a moment later.
   */
  if (req?.apiToken?.userId) {
    const db = await getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.apiToken.userId);
    if (!row) return null;
    const user = toClientUser(withPersonalFolder(db, row));
    if (user) {
      // Which kind of account this is lives in `auth_methods` rather than on
      // the row — the column that used to say so was carried there years ago.
      const local = db
        .prepare(
          `SELECT 1 FROM auth_methods
           WHERE user_id = ? AND method_type = 'local_password' AND enabled = 1
           LIMIT 1`
        )
        .get(row.id);
      user.provider = local ? 'local' : 'oidc';
    }
    return user;
  }

  // Local session
  if (req?.session?.localUserId) {
    const db = await getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.localUserId);
    const user = toClientUser(withPersonalFolder(db, row));
    if (user) {
      user.provider = 'local';
    }
    return user;
  }

  // OIDC mapped user
  if (
    req?.oidc &&
    typeof req.oidc.isAuthenticated === 'function' &&
    req.oidc.isAuthenticated() &&
    req.oidc.user?.sub
  ) {
    const issuer = (envAuthConfig && envAuthConfig.oidc && envAuthConfig.oidc.issuer) || null;
    if (!issuer) return null;
    const autoCreateUsers =
      (envAuthConfig && envAuthConfig.oidc && envAuthConfig.oidc.autoCreateUsers) ?? true;

    const db = await getDb();
    const authMethod = db
      .prepare(
        `
      SELECT user_id FROM auth_methods
      WHERE provider_issuer = ? AND provider_sub = ? AND method_type = 'oidc'
    `
      )
      .get(issuer, req.oidc.user.sub);

    if (authMethod) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(authMethod.user_id);
      const user = toClientUser(withPersonalFolder(db, row));
      if (user) {
        user.provider = 'oidc';
        user.oidcIssuer = issuer;
        if (!user.avatarUrl && typeof req.oidc.user.picture === 'string') {
          const trimmed = req.oidc.user.picture.trim();
          if (trimmed) {
            user.avatarUrl = trimmed;
          }
        }
      }
      return user;
    }

    // When auto-create is disabled, do not allow a synthetic user fallback.
    if (!autoCreateUsers) return null;

    // Fallback: derive a minimal user object from OIDC claims when DB sync hasn't happened yet
    try {
      const claims = req.oidc.user || {};
      const email = normalizeEmail(claims.email || '');
      const preferredUsername = claims.preferred_username || claims.username || email || claims.sub;
      const displayName = claims.name || preferredUsername || null;
      const roles = deriveRolesFromClaims(claims, envAuthConfig?.oidc?.adminGroups);
      const avatarUrl =
        typeof claims.picture === 'string' && claims.picture.trim() ? claims.picture.trim() : null;

      return {
        id: `oidc:${claims.sub}`,
        email,
        emailVerified: claims.email_verified || false,
        username: preferredUsername,
        displayName,
        avatarUrl,
        provider: 'oidc',
        roles,
        createdAt: null,
        updatedAt: null,
        // The subject, not the username.
        //
        // This account has no row yet, so there is no claimed folder name to
        // carry and nothing to claim one against. Left null, the folder would be
        // derived from `USER_FOLDER_NAME_ORDER` — and the order the reference
        // recommends for reusing /home puts `username` first, which two
        // identities from two providers can share. The claim mechanism exists to
        // stop exactly that, and it cannot run here.
        //
        // The subject is unique to the provider that issued it, so it is a
        // folder of this account's own. It is deliberately not the folder the
        // account will get once its row exists: that one is claimed, recorded
        // and permanent, and guessing at it here would be handing out a name
        // nothing had reserved.
        personalFolderName: `oidc-${claims.sub}`,
      };
    } catch (_) {
      return null;
    }
  }

  return null;
};

module.exports = {
  getRequestUser,
};
