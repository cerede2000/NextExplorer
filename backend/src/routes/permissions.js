const express = require('express');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} = require('../errors/AppError');

const router = express.Router();
// execFile never spawns a shell: user-supplied owner/group names and file paths
// stay plain arguments instead of being interpolated into a command string.
const execFileAsync = promisify(execFile);

// POSIX-portable account name, or a numeric id. Rejecting anything else keeps
// `chown` from receiving a value it would read as an option.
const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;

const ensureValidAccountName = (value, label) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !ACCOUNT_NAME_PATTERN.test(value)) {
    throw new ValidationError(`Invalid ${label} name.`);
  }
  return value;
};

/**
 * Get file permissions, owner, and group information
 */
router.get(
  '/permissions/{*splat}',
  asyncHandler(async (req, res) => {
    const rawPath = (req.params.splat || []).join('/');
    const relativePath = normalizeRelativePath(rawPath);

    if (!relativePath) {
      throw new ValidationError('A file path is required.');
    }

    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      relativePath,
      ACTIONS.read
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
    }

    try {
      const stats = await fs.stat(resolved.absolutePath);

      // Get owner and group information
      // On Unix systems, we can use uid/gid, but we need the names
      let owner = stats.uid.toString();
      let group = stats.gid.toString();

      // Try to get username and group name (Unix/Linux/macOS)
      if (process.platform !== 'win32') {
        try {
          // Get owner name from uid
          const { stdout: ownerOut } = await execFileAsync('id', ['-nu', String(stats.uid)]);
          owner = ownerOut.trim();
        } catch (e) {
          logger.debug({ err: e }, 'Failed to get owner name');
        }

        try {
          // Get group name from gid
          const { stdout: groupOut } = await execFileAsync('id', ['-gn', String(stats.gid)]);
          group = groupOut.trim();
        } catch (e) {
          logger.debug({ err: e }, 'Failed to get group name');
        }
      }

      res.json({
        path: relativePath,
        mode: stats.mode,
        owner,
        group,
        uid: stats.uid,
        gid: stats.gid,
        isDirectory: stats.isDirectory(),
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Path not found.');
      }
      throw error;
    }
  })
);

/**
 * Change file permissions (chmod)
 */
router.post(
  '/permissions/chmod',
  // Changing modes on a shared volume is an administration task: a plain
  // write permission on a path is not consent to re-permission its tree.
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { path: rawPath, mode, recursive } = req.body;

    if (!rawPath) {
      throw new ValidationError('Path is required.');
    }

    if (!mode || !/^[0-7]{3}$/.test(mode)) {
      throw new ValidationError('Mode must be a 3-digit octal string (e.g., "755").');
    }

    // Guests never reach this point: they have no req.user. Carrying a guest
    // session on top of a real account does not make the account a guest.
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const relativePath = normalizeRelativePath(rawPath);
    if (relativePath.startsWith('share/')) {
      throw new ForbiddenError('Permissions cannot be changed through a share.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      relativePath,
      ACTIONS.write
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
    }

    try {
      // Check if path exists
      await fs.stat(resolved.absolutePath);

      // Use chmod via Node.js built-in
      const modeInt = parseInt(mode, 8);
      await fs.chmod(resolved.absolutePath, modeInt);

      // If recursive and directory, apply to all children
      if (recursive) {
        const stats = await fs.stat(resolved.absolutePath);
        if (stats.isDirectory()) {
          // Use chmod -R for recursive on Unix systems
          if (process.platform !== 'win32') {
            try {
              // No `--` separator here: BSD chmod (macOS) does not accept it.
              // The path is always absolute, so it can never look like a flag.
              await execFileAsync('chmod', ['-R', mode, resolved.absolutePath]);
            } catch (e) {
              logger.error({ err: e }, 'Failed to apply recursive chmod');
              throw new Error('Failed to apply permissions recursively.');
            }
          } else {
            // On Windows, we'd need to recursively walk the directory
            // For now, just apply to the top-level
            logger.warn('Recursive chmod not fully supported on Windows');
          }
        }
      }

      logger.info({ path: relativePath, mode, recursive }, 'Permissions changed');

      res.json({
        success: true,
        path: relativePath,
        mode: modeInt,
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Path not found.');
      }
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        throw new ForbiddenError('Permission denied to change permissions.');
      }
      throw error;
    }
  })
);

/**
 * Change file owner or group (chown)
 */
router.post(
  '/permissions/chown',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { path: rawPath, owner, group } = req.body;

    if (!rawPath) {
      throw new ValidationError('Path is required.');
    }

    if (!owner && !group) {
      throw new ValidationError('Either owner or group must be specified.');
    }

    const safeOwner = ensureValidAccountName(owner, 'owner');
    const safeGroup = ensureValidAccountName(group, 'group');

    // Same as above: only a real account gets here.
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const relativePath = normalizeRelativePath(rawPath);
    if (relativePath.startsWith('share/')) {
      throw new ForbiddenError('Ownership cannot be changed through a share.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      relativePath,
      ACTIONS.write
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
    }

    try {
      // Check if path exists
      await fs.stat(resolved.absolutePath);

      // Node has no built-in owner/group change by name, so the system tools do
      // it. Arguments are passed as an array, never through a shell, and the
      // account names were validated above so they cannot look like flags
      // (the path is absolute, so it cannot either).
      if (process.platform !== 'win32') {
        let command = '';
        let args = [];

        if (safeOwner && safeGroup) {
          command = 'chown';
          args = [`${safeOwner}:${safeGroup}`, resolved.absolutePath];
        } else if (safeOwner) {
          command = 'chown';
          args = [safeOwner, resolved.absolutePath];
        } else {
          command = 'chgrp';
          args = [safeGroup, resolved.absolutePath];
        }

        try {
          await execFileAsync(command, args);
          logger.info({ path: relativePath, owner, group }, 'Ownership changed');
        } catch (e) {
          logger.error({ err: e }, 'Failed to change ownership');

          if (e.message.includes('Operation not permitted')) {
            throw new ForbiddenError(
              'Permission denied. Changing ownership typically requires root/admin privileges.'
            );
          }
          throw new Error('Failed to change ownership: ' + e.message);
        }
      } else {
        throw new ValidationError('Changing ownership is not supported on Windows.');
      }

      res.json({
        success: true,
        path: relativePath,
        owner,
        group,
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Path not found.');
      }
      throw error;
    }
  })
);

module.exports = router;
