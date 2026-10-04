const express = require('express');
const path = require('path');
const { directories } = require('../config/index');
const { getPublicSettings } = require('../services/settingsService');
const { ownLogoName } = require('../services/brandingLogo');
const asyncHandler = require('../utils/asyncHandler');

/**
 * The name and the logo a page draws itself with, answered to anybody.
 *
 * Its own file because it is answered in two places: at `/api/branding`, where
 * the sign-in screen reads it before anyone has signed in, and under a share's
 * prefix, where somebody with no account reads it from behind an authentication
 * proxy that lets the share through and nothing else. The same handler in both,
 * so what a share's page is told can never drift from what every other page is.
 *
 * The logo's own bytes are here too. A chosen logo is a file in `/config/logos`,
 * served at `/static/logos/<name>` — a path of its own in front of such a proxy,
 * which is the whole reason the default logo moved under `/assets/`. Handed that
 * address, a share's page drew a broken image where the logo belongs. Served
 * from this router it is reachable wherever the branding is, and the branding
 * answer points at it there.
 */
const router = express.Router();

/** The share whose prefix this router was reached under, or '' for anywhere else. */
const shareTokenOf = (req) => {
  const match = /^\/api\/share\/([^/]+)/.exec(String(req.baseUrl || ''));
  return match ? match[1] : '';
};

/**
 * Where the logo is, as the page that asked must ask for it.
 *
 * Moved only for a page inside a share, which is the one that cannot reach
 * `/static/logos`; every other page is told what the settings hold, as it always
 * was. And only for a logo this application holds: the stored value may be an
 * address elsewhere entirely, or the default one, and neither is ours to move.
 */
const logoAddress = (req, url) => {
  const token = shareTokenOf(req);
  const name = token ? ownLogoName(url) : null;
  if (!name) return url;
  return `/api/share/${encodeURIComponent(token)}/branding/logo/${encodeURIComponent(name)}`;
};

router.get(
  '/branding',
  asyncHandler(async (req, res) => {
    const { branding } = await getPublicSettings();
    res.json({ ...branding, appLogoUrl: logoAddress(req, branding?.appLogoUrl) });
  })
);

// A branding logo may be an SVG, which the browser executes when opened
// directly. The upload only checks the declared MIME type, so the sandbox is
// what actually keeps it from running on the app origin — the same header
// `/static/logos` is served with.
router.use(
  '/branding/logo',
  (_req, res, next) => {
    res.setHeader('Content-Security-Policy', 'sandbox');
    next();
  },
  express.static(path.join(directories.config, 'logos'))
);

module.exports = router;
