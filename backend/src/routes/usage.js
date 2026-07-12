const express = require('express');
const fs = require('fs/promises');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();

const toSafeNumber = (value) => {
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
};

const getFilesystemUsage = async (root) => {
  try {
    const stats = await fs.statfs(root);
    const blockSize = toSafeNumber(stats.bsize);
    const total = toSafeNumber(stats.blocks) * blockSize;
    const free = toSafeNumber(stats.bavail) * blockSize;
    const used = Math.max(0, total - free);
    const percentUsed = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

    return {
      size: used,
      used,
      free,
      total,
      percentUsed,
    };
  } catch (err) {
    logger.debug({ err, root }, 'Failed to read filesystem usage');
    return {
      size: 0,
      used: 0,
      free: 0,
      total: 0,
      percentUsed: 0,
    };
  }
};

router.get(
  '/usage/*',
  asyncHandler(async (req, res) => {
    const raw = req.params[0] || '';
    const inputRel = normalizeRelativePath(raw);
    const context = { user: req.user, guestSession: req.guestSession };

    const { accessInfo, resolved } = await resolvePathWithAccess(context, inputRel);

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      return res.json({
        path: inputRel,
        size: 0,
        used: 0,
        free: 0,
        total: 0,
        percentUsed: 0,
      });
    }

    const { absolutePath: abs, relativePath: rel } = resolved;
    res.json({ path: rel, ...(await getFilesystemUsage(abs)) });
  })
);

module.exports = router;
