const { transferItems } = require('../../services/fileTransferService');
const recentDestinations = require('../../services/recentDestinationsService');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const fs = require('node:fs/promises');
const asyncHandler = require('../../utils/asyncHandler');

const router = require('express').Router();

/**
 * Where this user has recently moved or copied things.
 *
 * Filtered against what they can reach right now: a folder can be deleted or
 * have its access revoked long after it was last used, and offering it as a
 * destination would only produce a failure at the end of the flow. Anything
 * gone is forgotten on the way out, so the list heals itself.
 */
router.get(
  '/files/recent-destinations',
  asyncHandler(async (req, res) => {
    const paths = await recentDestinations.list(req.user?.id);
    const context = { user: req.user, guestSession: req.guestSession };

    const reachable = [];
    for (const relativePath of paths) {
      const { allowed, resolved } = await authorizeAndResolve(context, relativePath, ACTIONS.write);
      const stats = resolved ? await fs.stat(resolved.absolutePath).catch(() => null) : null;

      if (allowed && stats?.isDirectory()) {
        reachable.push(relativePath);
      } else {
        await recentDestinations.forget(req.user?.id, relativePath);
      }
    }

    res.json({ items: reachable });
  })
);

router.post(
  '/files/copy',
  asyncHandler(async (req, res) => {
    const { items = [], destination = '' } = req.body || {};
    const result = await transferItems(items, destination, 'copy', {
      user: req.user,
      guestSession: req.guestSession,
    });
    // Recorded from the transfer itself rather than asked of the client, so every
    // route into a folder counts — the picker, a drag onto a favorite, a paste —
    // and the list reflects where things really go.
    await recentDestinations.record(req.user?.id, result.destination);

    res.json({ success: true, ...result });
  })
);

router.post(
  '/files/move',
  asyncHandler(async (req, res) => {
    const { items = [], destination = '' } = req.body || {};
    const result = await transferItems(items, destination, 'move', {
      user: req.user,
      guestSession: req.guestSession,
    });
    // Recorded from the transfer itself rather than asked of the client, so every
    // route into a folder counts — the picker, a drag onto a favorite, a paste —
    // and the list reflects where things really go.
    await recentDestinations.record(req.user?.id, result.destination);

    res.json({ success: true, ...result });
  })
);

module.exports = router;
