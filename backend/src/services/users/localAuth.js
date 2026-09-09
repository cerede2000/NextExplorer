const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const logger = require('../../utils/logger');
const { nowIso, toClientUser, generateId, normalizeEmail, usernameTaken } = require('./utils');
const { isLocked, incrementFailedAttempts, clearLock, getLock } = require('./lockout');
const {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  ConflictError,
} = require('../../errors/AppError');
const { ErrorCodes } = require('../../errors/errorCodes');

/**
 * The account someone means by what they typed, or null.
 *
 * An email is looked up first: it is unique by schema, so it can never be
 * ambiguous. A username is not — the column carries no uniqueness constraint,
 * and `createLocalUser` derives one from the local part of the address, so two
 * people on different domains genuinely can end up as `alice`.
 *
 * Where a name matches more than one account it identifies nobody, and picking
 * one would be choosing whose account a stranger signs into. Those accounts
 * keep their email, which is unambiguous by construction.
 */
const findUserByIdentifier = (db, typed) => {
  const trimmed = typeof typed === 'string' ? typed.trim() : '';
  if (!trimmed) return null;

  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(trimmed));
  if (byEmail) return byEmail;

  // Without regard to case, because nobody remembers whether they capitalised
  // their own name — and because the column would let `Alice` and `alice` be
  // two accounts, which is exactly the ambiguity refused below.
  const matches = db
    .prepare(
      "SELECT * FROM users WHERE username IS NOT NULL AND username <> '' AND lower(username) = lower(?)"
    )
    .all(trimmed);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(
      { username: trimmed, accounts: matches.length },
      'Several accounts share this username; it cannot be used to sign in. They can use their email address.'
    );
  }
  return null;
};

/**
 * Sign in with an email address or a username, and a password.
 *
 * @param {{identifier?: string, email?: string, password: string}} credentials
 *   `email` is accepted as the older name for `identifier`.
 */
const attemptLocalLogin = async ({ identifier, email, password }) => {
  const db = await getDb();

  const user = findUserByIdentifier(db, identifier ?? email);
  if (!user) {
    // No counter for something that names no account. The lock is per account,
    // so counting here would let anyone lock a colleague out by guessing at
    // their address. Brute force is bounded by the login rate limit.
    return null;
  }

  // Keyed on the account rather than on what was typed. One account answering
  // to two names would otherwise get one lockout budget per name, and anyone
  // alternating between them would never exhaust either.
  const lockKey = user.id;

  if (await isLocked(lockKey)) {
    const lock = await getLock(lockKey);
    const until = lock.locked_until || null;
    const err = new Error('Account is temporarily locked due to failed login attempts.');
    err.status = 423;
    err.code = ErrorCodes.AUTH_ACCOUNT_LOCKED;
    err.until = until;
    throw err;
  }

  // Find local password auth method
  const authMethod = db
    .prepare(
      `
    SELECT * FROM auth_methods
    WHERE user_id = ? AND method_type = 'local_password' AND enabled = 1
  `
    )
    .get(user.id);

  if (!authMethod || !authMethod.password_hash) {
    await incrementFailedAttempts(lockKey);
    return null;
  }

  // Verify password
  const valid = await bcrypt.compare(password || '', authMethod.password_hash);
  if (!valid) {
    await incrementFailedAttempts(lockKey);
    return null;
  }

  // Success - clear lockout
  await clearLock(lockKey);
  db.prepare('UPDATE auth_methods SET last_used_at = ? WHERE id = ?').run(nowIso(), authMethod.id);

  let clientUser = toClientUser(user);
  if (clientUser) {
    clientUser.provider = 'local';
  }
  return clientUser;
};

// Create user with local password authentication
const createLocalUser = async ({ email, password, username, displayName, roles = ['user'] }) => {
  const db = await getDb();
  const normEmail = normalizeEmail(email);

  if (!normEmail) {
    throw new ValidationError('Email is required', null, ErrorCodes.VALIDATION_EMAIL_REQUIRED);
  }

  if (!password || password.length < 6) {
    throw new ValidationError(
      'Password must be at least 6 characters long',
      null,
      ErrorCodes.VALIDATION_PASSWORD_TOO_SHORT
    );
  }

  // A username is something to sign in with, so it has to name one account.
  // Nothing removes the duplicates an older version allowed; this stops more
  // being made.
  if (usernameTaken(db, username)) {
    throw new ConflictError('Username already in use', ErrorCodes.CONFLICT_USER_EXISTS);
  }

  // Check if user exists
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);

  if (user) {
    // User exists - check if they already have local password
    const existingAuth = db
      .prepare(
        `
      SELECT id FROM auth_methods
      WHERE user_id = ? AND method_type = 'local_password'
    `
      )
      .get(user.id);

    if (existingAuth) {
      throw new ConflictError(
        'User already has local password authentication',
        ErrorCodes.CONFLICT_PASSWORD_EXISTS
      );
    }

    // Auto-link: Add password auth to existing user
    logger.info({ email: user.email }, '[Auth] Adding password auth to existing user');

    const hash = await bcrypt.hash(password, 12);
    const authId = generateId();

    db.prepare(
      `
      INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo, created_at)
      VALUES (?, ?, 'local_password', ?, 'bcrypt', ?)
    `
    ).run(authId, user.id, hash, nowIso());

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return toClientUser(user);
  }

  // New user: Create user and password auth
  const userId = generateId();
  const now = nowIso();
  const rolesJson = JSON.stringify(Array.isArray(roles) ? roles : ['user']);
  const hash = await bcrypt.hash(password, 12);

  // Create user
  db.prepare(
    `
    INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?)
  `
  ).run(userId, normEmail, username, displayName, rolesJson, now, now);

  // Create password auth method
  const authId = generateId();
  db.prepare(
    `
    INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo, created_at)
    VALUES (?, ?, 'local_password', ?, 'bcrypt', ?)
  `
  ).run(authId, userId, hash, now);

  user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return toClientUser(user);
};

// Change password for user with local password auth
const changeLocalPassword = async ({ userId, currentPassword, newPassword }) => {
  const db = await getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new NotFoundError('User not found.', ErrorCodes.NOT_FOUND_USER);
  }

  // Check if user has local password auth
  const authMethod = db
    .prepare(
      `
    SELECT * FROM auth_methods
    WHERE user_id = ? AND method_type = 'local_password' AND enabled = 1
  `
    )
    .get(userId);

  if (!authMethod || !authMethod.password_hash) {
    throw new ValidationError(
      'Password change is only allowed for users with password authentication.'
    );
  }

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new ValidationError('Current password is required.');
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new ValidationError(
      'Password must be at least 6 characters long.',
      null,
      ErrorCodes.VALIDATION_PASSWORD_TOO_SHORT
    );
  }

  if (!(await bcrypt.compare(currentPassword, authMethod.password_hash))) {
    throw new UnauthorizedError(
      'Current password is incorrect.',
      ErrorCodes.AUTH_PASSWORD_INCORRECT
    );
  }

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE auth_methods SET password_hash = ? WHERE id = ?').run(hash, authMethod.id);
  return true;
};

// Admin path: set a local user's password without current password
const setLocalPasswordAdmin = async ({ userId, newPassword }) => {
  const db = await getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    const e = new Error('User not found.');
    e.status = 404;
    throw e;
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    const e = new Error('Password must be at least 6 characters long.');
    e.status = 400;
    throw e;
  }

  const hash = await bcrypt.hash(newPassword, 12);

  // Check if user has local password auth
  const authMethod = db
    .prepare(
      `
    SELECT id FROM auth_methods
    WHERE user_id = ? AND method_type = 'local_password'
  `
    )
    .get(userId);

  if (authMethod) {
    // Update existing password
    db.prepare('UPDATE auth_methods SET password_hash = ? WHERE id = ?').run(hash, authMethod.id);
  } else {
    // Create new password auth method
    const authId = generateId();
    db.prepare(
      `
      INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo, created_at)
      VALUES (?, ?, 'local_password', ?, 'bcrypt', ?)
    `
    ).run(authId, userId, hash, nowIso());
  }

  return true;
};

// Add password auth to existing user (for OIDC-only users)
const addLocalPassword = async ({ userId, password }) => {
  const db = await getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    const e = new Error('User not found.');
    e.status = 404;
    throw e;
  }

  // Check if user already has password auth
  const existing = db
    .prepare(
      `
    SELECT id FROM auth_methods
    WHERE user_id = ? AND method_type = 'local_password'
  `
    )
    .get(userId);

  if (existing) {
    throw new ConflictError(
      'You already have password authentication.',
      ErrorCodes.CONFLICT_PASSWORD_EXISTS
    );
  }

  if (!password || password.length < 6) {
    throw new ValidationError(
      'Password must be at least 6 characters long.',
      null,
      ErrorCodes.VALIDATION_PASSWORD_TOO_SHORT
    );
  }

  const hash = await bcrypt.hash(password, 12);
  const authId = generateId();

  db.prepare(
    `
    INSERT INTO auth_methods (id, user_id, method_type, password_hash, password_algo, created_at)
    VALUES (?, ?, 'local_password', ?, 'bcrypt', ?)
  `
  ).run(authId, userId, hash, nowIso());

  return true;
};

module.exports = {
  attemptLocalLogin,
  createLocalUser,
  changeLocalPassword,
  setLocalPasswordAdmin,
  addLocalPassword,
};
