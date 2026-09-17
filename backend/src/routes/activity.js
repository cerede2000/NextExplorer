const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const activityLog = require('../services/activityLog');

/**
 * Reading the activity log.
 *
 * Administrators only, and not because the rows are secret from the people in
 * them: a log is a record of everybody who shares the installation, and one
 * person's afternoon is not another person's business. The switch that fills
 * it lives with the other settings; this is the reading side.
 */

const router = express.Router();

/** A page of history, newest first, narrowed by whatever was asked. */
router.get(
  '/activity',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const { action, user, outcome, from, to, q, before, limit } = req.query || {};
    const page = await activityLog.readActivity({
      action,
      userId: user,
      outcome,
      from,
      to,
      query: q,
      before,
      limit,
    });

    res.json({
      ...page,
      enabled: await activityLog.isEnabled(),
      actions: [...activityLog.ACTIONS],
    });
  })
);

/**
 * Everything, at once.
 *
 * The one thing an administrator may want that a retention cannot give them: a
 * log switched on to look into something, and emptied when it is over.
 */
router.delete(
  '/activity',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    res.json({ removed: await activityLog.clearActivity() });
  })
);

module.exports = router;
