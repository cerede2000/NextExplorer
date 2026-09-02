const path = require('path');
const fs = require('fs');
const express = require('express');
const { directories, auth } = require('../config/index');
const logger = require('./logger');

/**
 * Thumbnails live outside /api, so the auth middleware never sees them.
 *
 * Their filenames are derived from the file path (`v<N>-<hash>.webp`), which
 * makes them guessable by anyone who can guess a path — and a 200 vs 404 also
 * answers "does this file exist". A session is not enough to decide here: it
 * says who is asking, not what they were cleared to see, so any share visitor
 * could ask for a filename belonging to another share or a private folder.
 *
 * The answer comes from /api/thumbnails, which runs the real access check and
 * signs the one filename it just cleared. This handler only verifies that
 * signature — no database read, no session, and nothing to confuse.
 */
const requireThumbnailToken = (req, res, next) => {
  if (auth.enabled === false) return next();

  // The cache is flat, so the request names one file and nothing else. Taking
  // the basename instead would let a token for "x.webp" unlock "sub/dir/x.webp".
  let filename = '';
  try {
    filename = decodeURIComponent((req.path || '').replace(/^\/+/, ''));
  } catch {
    // A malformed escape sequence throws; it matches no thumbnail either way.
    return res.status(401).end();
  }
  const token = typeof req.query?.t === 'string' ? req.query.t : '';

  const { verifyThumbnailToken } = require('./thumbnailTokens');
  if (filename && !filename.includes('/') && verifyThumbnailToken(filename, token)) return next();

  logger.debug({ filename }, 'Thumbnail request without a valid token');
  res.status(401).end();
};

/**
 * Configures static file serving for thumbnails, logos, and frontend
 */
/**
 * @param {import('express').Application} app
 * @param {string} [frontendDirectory] where the built frontend lives. Defaults
 *   to where the image puts it; a caller passes its own so this can be
 *   exercised — the single-page fallback is the one route only production
 *   registers, and it was the one that stopped the server from starting.
 */
const configureStaticFiles = (app, frontendDirectory) => {
  // Serve thumbnails
  app.use('/static/thumbnails', requireThumbnailToken, express.static(directories.thumbnails));
  logger.debug('Mounted /static/thumbnails');

  // Serve custom logos
  const logosDir = path.join(directories.config, 'logos');
  if (!fs.existsSync(logosDir)) {
    try {
      fs.mkdirSync(logosDir, { recursive: true });
    } catch (error) {
      logger.warn('Failed to create logos directory', { error: error.message });
    }
  }
  // A branding logo may be an SVG, which the browser executes when opened
  // directly. The upload only checks the declared MIME type, so the sandbox is
  // what actually keeps it from running on the app origin.
  app.use(
    '/static/logos',
    (_req, res, next) => {
      res.setHeader('Content-Security-Policy', 'sandbox');
      next();
    },
    express.static(logosDir)
  );
  logger.debug('Mounted /static/logos');

  // Serve frontend SPA
  const frontendDir = frontendDirectory || path.resolve(__dirname, '..', 'public');
  const indexFile = path.join(frontendDir, 'index.html');

  if (fs.existsSync(frontendDir) && fs.existsSync(indexFile)) {
    app.use(express.static(frontendDir));
    logger.debug({ frontendDir, indexFile }, 'Mounted static frontend');

    // SPA fallback - serve index.html for all non-API routes.
    //
    // `{*splat}` and not `*`: path-to-regexp 8, which Express 5 uses, refuses a
    // bare wildcard outright — and it refuses it while the route is being
    // registered, so the server does not start at all. The braces are what
    // keep `/` itself matching, which is the address the application is
    // usually opened at.
    app.get('{*splat}', (req, res, next) => {
      // Skip API routes and static asset routes
      if (req.path.startsWith('/api') || req.path.startsWith('/static/')) {
        return next();
      }

      // Only handle GET and HEAD requests
      if (!['GET', 'HEAD'].includes(req.method)) {
        return next();
      }

      res.sendFile(indexFile);
    });

    logger.debug('Configured SPA fallback routing');
  } else {
    logger.warn(
      { frontendDir, indexFile },
      'Frontend directory or index.html not found - skipping static file serving'
    );
  }
};

module.exports = { configureStaticFiles };
