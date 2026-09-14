const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const trash = require('../services/trash');

const router = express.Router();

const contextOf = (req) => ({ user: req.user, guestSession: req.guestSession });

// GET /api/trash - what the signed-in person's trash holds
router.get(
  '/trash',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await trash.listItems(contextOf(req)));
  })
);

// POST /api/trash/restore - put items back where they were deleted from
router.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    res.json(await trash.restoreItems(req.body?.ids, contextOf(req)));
  })
);

// GET /api/trash/items/:id/entries?path= - what a deleted folder holds, at a path inside it
router.get(
  '/trash/items/:id/entries',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await trash.listEntries(req.params.id, req.query.path ?? '', contextOf(req)));
  })
);

// POST /api/trash/items/:id/restore - put back entries from inside a deleted folder
router.post(
  '/trash/items/:id/restore',
  asyncHandler(async (req, res) => {
    res.json(await trash.restoreEntries(req.params.id, req.body?.paths, contextOf(req)));
  })
);

// POST /api/trash/delete - remove items for good
router.post(
  '/trash/delete',
  asyncHandler(async (req, res) => {
    res.json(
      await trash.purgeItems(req.body?.ids, contextOf(req), {
        forgetUnavailable: req.body?.forgetUnavailable === true,
      })
    );
  })
);

// POST /api/trash/empty - remove everything this person can see, for good
router.post(
  '/trash/empty',
  asyncHandler(async (req, res) => {
    res.json(await trash.emptyTrash(contextOf(req)));
  })
);

// GET /api/trash/zones - every zone, what it holds and may hold (admin only)
router.get(
  '/trash/zones',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ zones: await trash.zonesOverview() });
  })
);

// POST /api/trash/verify - check every zone against its invariants (admin only)
router.post(
  '/trash/verify',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await trash.verifyAll());
  })
);

// POST /api/trash/maintenance - run the maintenance pass now (admin only)
router.post(
  '/trash/maintenance',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ zones: await trash.runMaintenance() });
  })
);

module.exports = router;
