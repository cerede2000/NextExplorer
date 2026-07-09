const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const terminalService = require('../services/terminalService');
const logger = require('../utils/logger');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { UnauthorizedError, ForbiddenError } = require('../errors/AppError');

const router = express.Router();

// POST /api/terminal/session - issue short-lived terminal session token (admin only)
router.post(
  '/terminal/session',
  asyncHandler(async (req, res) => {
    if (!terminalService.isAvailable()) {
      return res.status(503).json({ error: 'Terminal feature is disabled or unavailable.' });
    }

    const user = req.user;

    if (!user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const roles = Array.isArray(user.roles) ? user.roles : [];
    const isAdmin = roles.includes('admin');

    if (!isAdmin) {
      throw new ForbiddenError('Admin privileges required to open terminal.');
    }

    let cwd = null;
    const requestedCwd = req.body?.cwd;

    if (typeof requestedCwd === 'string' && requestedCwd.trim()) {
      try {
        const logicalCwd = normalizeRelativePath(requestedCwd);
        if (logicalCwd) {
          const { accessInfo, resolved } = await resolvePathWithAccess({ user }, logicalCwd);
          cwd = accessInfo?.canRead
            ? await terminalService.resolveWorkingDirectory(resolved)
            : null;
        }
      } catch (error) {
        logger.warn(
          { requestedCwd, userId: user.id, err: error },
          'Failed to resolve terminal working directory; using default shell directory'
        );
      }
    }

    const token = terminalService.createSessionToken(user, { cwd });

    res.json({ token });
  })
);

module.exports = router;
