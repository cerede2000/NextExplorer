const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const activityLog = require('../services/activityLog');
const {
  FORWARDING_HEADERS,
  clientAddress,
  normalizeAddress,
  peerIsTrusted,
} = require('../utils/clientAddress');

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
 *
 * Emptying it is itself something somebody did, so the log says so: the line
 * is written after the deletion, which makes it the only one to survive it. A
 * log that can be emptied without a trace is worth less than the rows it lost.
 */
router.delete(
  '/activity',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    const removed = await activityLog.clearActivity();
    await activityLog.record({
      action: 'admin.activity-clear',
      user: req.user,
      detail: { removed },
      req,
    });
    res.json({ removed });
  })
);

/**
 * Where this server thinks the request came from, and why.
 *
 * The question every operator asks once, in front of a log whose every line
 * carries the same address: is the proxy not announcing anybody, or is this
 * server not believing it? Reading the code to find out is an afternoon;
 * opening this is a minute. It answers about the person asking and nobody
 * else, and only for an administrator.
 */
router.get('/activity/address', ensureAdmin, (req, res) => {
  const announced = {};
  for (const name of FORWARDING_HEADERS) {
    const value = req.get(name);
    if (value) announced[name] = value;
  }

  res.json({
    recorded: clientAddress(req),
    peer: normalizeAddress(req.socket?.remoteAddress),
    // Whether this server would believe what that peer announces, and the
    // rule it is deciding with — which is also how to tell that TRUST_PROXY
    // never reached the process.
    trustsPeer: peerIsTrusted(req),
    trustProxy: req.app.get('trust proxy') ?? false,
    // Nothing here means nobody announced a client: a tunnel forwarding raw
    // TCP rather than HTTP has no header to add, and no setting recovers an
    // address that never arrived.
    announced,
  });
});

module.exports = router;
