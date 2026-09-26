const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const capabilities = require('../services/capabilities');

const router = express.Router();

/**
 * Which optional tools this installation has, for the About page.
 *
 * The same report the server writes to its log at start, for an administrator
 * who does not read logs (#9). Administrators only: which programs are
 * installed on the host, and at which paths, is not something every account
 * needs to learn.
 */
router.get(
  '/capabilities',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    const list = await capabilities.describe();
    // What the page shows and nothing more: the log wording stays in the log.
    res.json({
      // eslint-disable-next-line no-unused-vars
      capabilities: list.map(({ lost: _lost, ...shown }) => shown),
    });
  })
);

module.exports = router;
