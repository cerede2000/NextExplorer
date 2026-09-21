const { getDb } = require('../db');
const { ForbiddenError } = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { nowIso, toClientUser, generateId, normalizeEmail } = require('./utils');

const GROUP_CLAIMS = ['groups', 'roles', 'entitlements'];

/**
 * Whether the provider said anything at all about this user's groups.
 *
 * A claim that is absent is not a claim that is empty. A `groups` scope missing
 * from the client configuration looks exactly like a user who belongs to
 * nothing — and the documented symptom of that mistake is "not an admin after
 * login". Acting on silence would turn a configuration error into a demotion.
 */
const hasGroupClaim = (claims = {}) =>
  GROUP_CLAIMS.some((claim) => claims?.[claim] !== undefined && claims?.[claim] !== null);

// Map provider claims/groups to an app roles array
const deriveRolesFromClaims = (claims = {}, adminGroups = []) => {
  try {
    const toArray = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);

    const groups = []
      .concat(toArray(claims.groups))
      .concat(toArray(claims.roles))
      .concat(toArray(claims.entitlements))
      .filter((g) => typeof g === 'string' && g.trim())
      .map((g) => g.trim().toLowerCase());

    const cfgAdmin = Array.isArray(adminGroups)
      ? adminGroups
          .map((g) => (typeof g === 'string' ? g.trim().toLowerCase() : ''))
          .filter(Boolean)
      : [];
    const isAdmin = cfgAdmin.some((g) => groups.includes(g));
    return isAdmin ? ['admin'] : ['user'];
  } catch (_) {
    return ['user'];
  }
};

// Get or create user from OIDC claims (with auto-linking via email)
/**
 * Whether the provider's answer about groups may overwrite the roles already
 * stored for a returning user.
 *
 * Two conditions, both necessary. Without `OIDC_ADMIN_GROUPS` every login
 * derives `['user']`, so re-applying it would strip the admin rights of anyone
 * promoted through the interface — the bootstrap account included — at their
 * next sign-in, leaving nobody able to administer the instance. And a group
 * claim that is absent is not a claim that is empty: a missing `groups` scope
 * looks exactly like a user who belongs to nothing, and its documented symptom
 * is "not an admin after login". Acting on silence turns a misconfiguration
 * into a demotion.
 */
/**
 * Say so when the provider's groups change what someone may do here. A silent
 * promotion or demotion is exactly the kind of thing an administrator needs to
 * be able to find afterwards.
 */
const logRoleChange = (db, userId, nextRolesJson) => {
  try {
    const current = db.prepare('SELECT roles FROM users WHERE id = ?').get(userId);
    if (!current || current.roles === nextRolesJson) return;
    logger.info(
      { userId, from: current.roles, to: nextRolesJson },
      "OIDC group membership changed this user's roles"
    );
  } catch (_) {
    /* logging must never break a login */
  }
};

const rolesFromClaimsAreAuthoritative = (claims, adminGroups) =>
  Array.isArray(adminGroups) && adminGroups.length > 0 && hasGroupClaim(claims);

const getOrCreateOidcUser = async ({
  issuer,
  sub,
  email,
  emailVerified,
  username,
  displayName,
  roles,
  // Only then may `roles` overwrite what a returning user already has.
  rolesAreAuthoritative = false,
  requireEmailVerified = false,
  autoCreateUsers = true,
}) => {
  const db = await getDb();
  const normEmail = normalizeEmail(email);
  const rolesJson = JSON.stringify(Array.isArray(roles) ? roles : ['user']);

  if (!normEmail) {
    throw new ForbiddenError('Email is required from OIDC provider.');
  }

  // This policy applies to every OIDC login when explicitly enabled.
  if (requireEmailVerified && !emailVerified) {
    throw new ForbiddenError('Email must be verified by identity provider.');
  }

  // Check if this OIDC identity already exists
  let authMethod = db
    .prepare(
      `
    SELECT * FROM auth_methods
    WHERE provider_issuer = ? AND provider_sub = ? AND method_type = 'oidc'
  `
    )
    .get(issuer, sub);

  if (authMethod) {
    // Existing OIDC auth - update last used
    db.prepare('UPDATE auth_methods SET last_used_at = ? WHERE id = ?').run(
      nowIso(),
      authMethod.id
    );

    // Update user profile from latest claims
    db.prepare(
      `
      UPDATE users
      SET display_name = COALESCE(?, display_name),
          username = COALESCE(?, username),
          email_verified = CASE WHEN ? THEN 1 ELSE email_verified END,
          roles = CASE WHEN ? THEN ? ELSE roles END,
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      displayName,
      username,
      emailVerified ? 1 : 0,
      rolesAreAuthoritative ? 1 : 0,
      rolesJson,
      nowIso(),
      authMethod.user_id
    );

    if (rolesAreAuthoritative) logRoleChange(db, authMethod.user_id, rolesJson);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authMethod.user_id);
    return toClientUser(user);
  }

  // New OIDC identity - check if user with this email exists
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);

  if (user) {
    // An unverified email claim must never attach a new OIDC identity to an
    // existing account, regardless of the provisioning configuration.
    if (!emailVerified) {
      throw new ForbiddenError('Email must be verified before linking an existing account.');
    }

    // Auto-link: User exists, add OIDC as new auth method
    logger.info('[Auth] Auto-linking OIDC to existing user');

    const authId = generateId();
    db.prepare(
      `
      INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
      VALUES (?, ?, 'oidc', ?, ?, ?, ?)
    `
    ).run(authId, user.id, issuer, sub, 'OIDC', nowIso());

    // Update user info from OIDC claims
    db.prepare(
      `
      UPDATE users
      SET display_name = COALESCE(?, display_name),
          username = COALESCE(?, username),
          email_verified = CASE WHEN ? THEN 1 ELSE email_verified END,
          roles = CASE WHEN ? THEN ? ELSE roles END,
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      displayName,
      username,
      emailVerified ? 1 : 0,
      rolesAreAuthoritative ? 1 : 0,
      rolesJson,
      nowIso(),
      user.id
    );

    if (rolesAreAuthoritative) logRoleChange(db, user.id, rolesJson);

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return toClientUser(user);
  }

  // New user: Create user and OIDC auth method
  if (!autoCreateUsers) {
    throw new ForbiddenError('Profile does not exist.');
  }

  logger.info('[Auth] Creating new user from OIDC');

  const userId = generateId();
  const now = nowIso();

  // Create user
  db.prepare(
    `
    INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(userId, normEmail, emailVerified ? 1 : 0, username, displayName, rolesJson, now, now);

  // Create OIDC auth method
  const authId = generateId();
  db.prepare(
    `
    INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
    VALUES (?, ?, 'oidc', ?, ?, ?, ?)
  `
  ).run(authId, userId, issuer, sub, 'OIDC', now);

  user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return toClientUser(user);
};

module.exports = {
  deriveRolesFromClaims,
  rolesFromClaimsAreAuthoritative,
  getOrCreateOidcUser,
};
