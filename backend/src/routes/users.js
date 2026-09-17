const express = require('express');
const {
  listUsers,
  listShareableUsers,
  updateUserRoles,
  updateUserProfile,
  createLocalUser,
  setLocalPasswordAdmin,
  deleteUser,
  getById,
  disableTwoFactor,
  twoFactorStatus,
} = require('../services/users');
const asyncHandler = require('../utils/asyncHandler');
const { searchLocalUsers } = require('../services/userSearchService');
const { NotFoundError, ValidationError, UnauthorizedError } = require('../errors/AppError');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const { clearLock, listActiveLocks } = require('../services/users/lockout');
const { deleteAllPasskeys } = require('../services/users/passkeys');
const activityLog = require('../services/activityLog');
const logger = require('../utils/logger');
const { startAuthenticatedSession } = require('../utils/authenticatedSession');

const router = express.Router();

// GET /api/users/shareable - list users for sharing (authenticated)
router.get(
  '/users/shareable',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const users = await listShareableUsers({ excludeUserId: req.user.id });
    res.json({ users });
  })
);

// GET /api/users/search?q=... - search users for mentions (authenticated)
router.get(
  '/users/search',
  asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const query = req.query.q || '';
    const users = await searchLocalUsers(query, 10);
    res.json({ users });
  })
);

// GET /api/users - list all users (admin only)
router.get(
  '/users',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const [users, locks] = await Promise.all([listUsers(), listActiveLocks()]);
    // Locks are keyed on the account (see localAuth), so the list can say which
    // account is locked and until when — the first question an administrator
    // has when somebody cannot sign in. Whether a second factor is on is the
    // second one, and the answer to "I have lost my phone".
    const withFactors = await Promise.all(
      users.map(async (user) => ({
        ...user,
        lockedUntil: locks.get(user.id) || null,
        twoFactorEnabled: (await twoFactorStatus(user.id)).enabled,
      }))
    );
    res.json({ users: withFactors });
  })
);

// PATCH /api/users/:id - update roles or profile (admin only)
router.patch(
  '/users/:id',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    const payload = req.body || {};
    const roles = Array.isArray(payload.roles) ? payload.roles : undefined;
    const existing = await getById(id);
    if (!existing) {
      throw new NotFoundError('User not found.');
    }

    let user = existing;

    if (Array.isArray(roles)) {
      const wasAdmin = Array.isArray(existing.roles) && existing.roles.includes('admin');
      const willBeAdmin = Array.isArray(roles) && roles.includes('admin');
      if (wasAdmin && !willBeAdmin) {
        throw new ValidationError('Demotion of admin is not allowed.');
      }
      user = await updateUserRoles({ userId: id, roles });
    }

    const hasProfileUpdates = ['email', 'username', 'displayName'].some(
      (key) => typeof payload[key] === 'string'
    );
    if (hasProfileUpdates) {
      user = await updateUserProfile({
        userId: id,
        email: payload.email,
        username: payload.username,
        displayName: payload.displayName,
      });
    }

    if (Array.isArray(roles) || hasProfileUpdates) {
      await activityLog.record({
        action: 'admin.user',
        user: req.user,
        target: user.username || user.email || id,
        detail: { roles: Array.isArray(roles) ? roles : undefined, profile: hasProfileUpdates },
        req,
      });
    }

    res.json({ user });
  })
);

// POST /api/users - create a new user (admin only)
router.post(
  '/users',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { email, username, password, displayName, roles } = req.body || {};
    const r = Array.isArray(roles) ? roles : [];
    const user = await createLocalUser({
      email,
      username: username || email?.split('@')[0],
      displayName: displayName || username || email?.split('@')[0],
      password,
      roles: r,
    });
    await activityLog.record({
      action: 'admin.user',
      user: req.user,
      target: user.username || user.email || user.id,
      detail: { created: true, roles: r },
      req,
    });
    res.status(201).json({ user });
  })
);

// POST /api/users/:id/password - admin reset local user's password
router.post(
  '/users/:id/password',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    const { newPassword } = req.body || {};
    // Every session of the account ends. An administrator resetting their own
    // password here is changing it, and keeps the session they did it from — on
    // a new id, as a change from their own settings does.
    const ownSession = Boolean(req.session) && req.session.localUserId === id;
    await setLocalPasswordAdmin({
      userId: id,
      newPassword,
      keepSessionId: ownSession ? req.sessionID : null,
    });
    if (ownSession) await startAuthenticatedSession(req, id);
    res.status(204).end();
  })
);

/**
 * DELETE /api/users/:id/two-factor — take somebody's second factor off.
 *
 * The lost phone with the recovery codes in the same bag. Without this the
 * answer is an administrator editing the database by hand, which is worse in
 * every way: this one is a deliberate act by somebody who can already reset
 * the account's password, and it says so in the log.
 */
router.delete(
  '/users/:id/two-factor',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    const user = await getById(id);
    if (!user) throw new NotFoundError('User not found');

    const removed = await disableTwoFactor(id);
    logger.warn(
      { userId: id, by: req.user?.id || null, removed },
      'An administrator turned two-factor authentication off for an account'
    );
    res.status(204).end();
  })
);

/**
 * DELETE /api/users/:id/passkeys — take somebody's passkeys off.
 *
 * The laptop that was the passkey, gone with the passkey on it. The same
 * deliberate act by the same person who could already reset the account's
 * password, for the same reason: the alternative is editing the database by
 * hand. What is left is an account that signs in with its password, and adds a
 * passkey again from whatever device is in front of it.
 */
router.delete(
  '/users/:id/passkeys',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    const user = await getById(id);
    if (!user) throw new NotFoundError('User not found');

    const removed = await deleteAllPasskeys(id);
    logger.warn(
      { userId: id, by: req.user?.id || null, removed },
      'An administrator removed the passkeys of an account'
    );
    await activityLog.record({
      action: 'admin.user',
      user: req.user,
      target: user.username || user.email || id,
      detail: { passkeysRemoved: removed },
      req,
    });
    res.status(204).end();
  })
);

// DELETE /api/users/:id/lock - release an account locked by failed sign-ins (admin only)
router.delete(
  '/users/:id/lock',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    const existing = await getById(id);
    if (!existing) {
      throw new NotFoundError('User not found.');
    }
    // The count as well as the deadline. Left on the books, the failures would
    // let the next typo lock the account straight back.
    await clearLock(id);
    logger.info({ adminId: req.user?.id, userId: id }, 'Sign-in lock released by an administrator');
    res.status(204).end();
  })
);

// DELETE /api/users/:id - remove a user (admin only)
router.delete(
  '/users/:id',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params || {};
    // prevent self-delete via API
    if (req.user?.id === id) {
      throw new ValidationError('You cannot delete your own account.');
    }
    const existing = await getById(id);
    if (!existing) {
      throw new NotFoundError('User not found.');
    }
    // The last administrator is protected by the service, so every caller of
    // deleteUser gets the rule and not only this route. A second copy here
    // read as the enforcement and was not: removing it changed nothing.
    await deleteUser({ userId: id });
    // Written after the deletion, and it outlives it: the row names the
    // account as text, and nothing cascades this log away.
    await activityLog.record({
      action: 'admin.user',
      user: req.user,
      target: existing.username || existing.email || id,
      detail: { deleted: true },
      req,
    });
    res.status(204).end();
  })
);

module.exports = router;
