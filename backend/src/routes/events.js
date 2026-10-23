const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const uploadEvents = require('../services/uploadEvents');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');

/**
 * Reading what has arrived, for something that acts on it.
 *
 * Open to any caller the application knows, including an API token, which is
 * the point: the consumer is usually a script. Not behind `ensureAdmin`, as
 * the activity log is — and so each row is weighed on its own. A reader is
 * handed an event only where they could open the file it names, which makes
 * this feed exactly as wide as what they can already browse, and no wider.
 *
 * Rows nobody may see are skipped rather than refused, and the cursor still
 * moves past them: a reader who may see none of a page must not be left
 * asking for the same page for ever, and must not learn from a gap in the ids
 * that something they cannot see happened.
 */

const router = express.Router();

router.get(
  '/events/uploads',
  asyncHandler(async (req, res) => {
    const { rows, cursor, more } = await uploadEvents.readSince({
      since: req.query?.since,
      limit: req.query?.limit,
    });

    const context = { user: req.user, guestSession: req.guestSession };
    const events = [];
    for (const row of rows) {
      let allowed;
      try {
        ({ allowed } = await authorizeAndResolve(context, row.path, ACTIONS.read));
      } catch (_) {
        // A path that cannot even be resolved is one this caller is not shown.
        allowed = false;
      }
      if (!allowed) continue;
      events.push({ id: row.id, at: row.at, path: row.path, size: row.size, via: row.via });
    }

    res.json({ events, cursor, more });
  })
);

module.exports = router;
