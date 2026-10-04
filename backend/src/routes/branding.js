const express = require('express');
const { getPublicSettings } = require('../services/settingsService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * The name and the logo a page draws itself with, answered to anybody.
 *
 * Its own file because it is answered in two places: at `/api/branding`, where
 * the sign-in screen reads it before anyone has signed in, and under a share's
 * prefix, where somebody with no account reads it from behind an authentication
 * proxy that lets the share through and nothing else. The same handler in both,
 * so what a share's page is told can never drift from what every other page is.
 */
const router = express.Router();

router.get(
  '/branding',
  asyncHandler(async (_req, res) => {
    const publicSettings = await getPublicSettings();
    res.json(publicSettings.branding);
  })
);

module.exports = router;
