const express = require('express');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const logger = require('../utils/logger');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const asyncHandler = require('../utils/asyncHandler');
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} = require('../errors/AppError');

const router = express.Router();
// `execFile`, not `exec`: every one of these used to build a command line with
// values from the request in it, and a shell then read that line. `owner` and
// `group` arrive from the body, so a pair of quotes was the whole difference
// between "may change ownership here" and "may run anything as the user this
// server runs as".
const execAsync = promisify(execFile);

/**
 * An account or group name has to look like one.
 *
 * An argument list is not a free pass on its own: `chown` reads anything starting
 * with a dash as an option, so `--reference=/etc/shadow` would have copied another
 * file's ownership onto the target. A name starts with a letter, a digit or an
 * underscore.
 */
const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;
const ensureValidAccountName = (value, label) => {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !ACCOUNT_NAME_PATTERN.test(value)) {
    throw new ValidationError(`${label} is not a valid name.`);
  }
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
          const { stdout: ownerOut } = await execAsync('id', ['-nu', String(stats.uid)]);
          owner = ownerOut.trim();
        } catch (e) {
          logger.debug({ err: e }, 'Failed to get owner name');
        }

        try {
          // Get group name from gid
          const { stdout: groupOut } = await execAsync('id', ['-gn', String(stats.gid)]);
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
  // Changing modes and ownership on a shared volume is an administration
  // task: a plain write permission on a path is not consent to re-permission
  // its tree. `ensureAdmin` says as much in its own comment, and these are the
  // two routes it was written for.
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { path: rawPath, mode, recursive } = req.body;

    if (!rawPath) {
      throw new ValidationError('Path is required.');
    }

    if (!mode || !/^[0-7]{3}$/.test(mode)) {
      throw new ValidationError('Mode must be a 3-digit octal string (e.g., "755").');
    }

    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }
    // Guests never reach this point: they have no req.user. Carrying a guest
    // session on top of a real account does not make the account a guest.

    const relativePath = normalizeRelativePath(rawPath);
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
              await execAsync('chmod', ['-R', String(mode), resolved.absolutePath]);
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
  // Changing modes and ownership on a shared volume is an administration
  // task: a plain write permission on a path is not consent to re-permission
  // its tree. `ensureAdmin` says as much in its own comment, and these are the
  // two routes it was written for.
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { path: rawPath, owner, group } = req.body;

    if (!rawPath) {
      throw new ValidationError('Path is required.');
    }

    if (!owner && !group) {
      throw new ValidationError('Either owner or group must be specified.');
    }

    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Authentication required');
    }
    // As above: a guest session beside an account is not a guest.

    const relativePath = normalizeRelativePath(rawPath);
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

      // chown requires shell execution as Node.js doesn't have built-in owner/group change
      // This requires elevated privileges on most systems
      if (process.platform !== 'win32') {
        ensureValidAccountName(owner, 'The owner');
        ensureValidAccountName(group, 'The group');

        let command = null;
        let args = [];

        if (owner && group) {
          command = 'chown';
          args = [`${owner}:${group}`, resolved.absolutePath];
        } else if (owner) {
          command = 'chown';
          args = [owner, resolved.absolutePath];
        } else if (group) {
          command = 'chgrp';
          args = [group, resolved.absolutePath];
        }

        try {
          if (command) await execAsync(command, args);
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
