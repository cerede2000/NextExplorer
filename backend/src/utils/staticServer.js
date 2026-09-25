const path = require('path');
const fs = require('fs');
const express = require('express');
const { auth, directories } = require('../config/index');
const logger = require('./logger');

/**
 * A thumbnail is served from /static, which the authentication middleware does
 * not cover, and its cache name is derived from the file's path — so anybody
 * who can guess a path can ask for the picture of it, and a 200 against a 404
 * answers "does this file exist" besides.
 *
 * A session would not settle it either: it says who is asking, not what they
 * were cleared to see, so a visitor holding a valid session for one share could
 * name a thumbnail belonging to another share or to a private folder.
 *
 * The decision is made by /api/thumbnails, which runs the real access check and
 * signs the one filename it just cleared. This reads that signature back — no
 * database, no session, nothing else to get wrong.
 */
const requireThumbnailToken = (req, res, next) => {
  if (auth.enabled === false) return next();

  // The cache is flat, so a request names one file and nothing else. Taking the
  // basename would let a token for "x.webp" unlock "sub/dir/x.webp".
  let filename;
  try {
    filename = decodeURIComponent((req.path || '').replace(/^\/+/, ''));
  } catch {
    // A malformed escape throws, and matches no thumbnail either way.
    return res.status(401).end();
  }
  const token = typeof req.query?.t === 'string' ? req.query.t : '';

  // eslint-disable-next-line global-require
  const { verifyThumbnailToken } = require('./thumbnailTokens');
  if (filename && !filename.includes('/') && verifyThumbnailToken(filename, token)) return next();

  logger.debug({ filename }, 'Thumbnail request without a valid token');
  return res.status(401).end();
};

/**
 * Configures static file serving for thumbnails, logos, and frontend
 */
const configureStaticFiles = (app) => {
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
  app.use('/static/logos', express.static(logosDir));
  logger.debug('Mounted /static/logos');

  // Serve frontend SPA
  const frontendDir = path.resolve(__dirname, '..', 'public');
  const indexFile = path.join(frontendDir, 'index.html');

  if (fs.existsSync(frontendDir) && fs.existsSync(indexFile)) {
    app.use(express.static(frontendDir));
    logger.debug({ frontendDir, indexFile }, 'Mounted static frontend');

    // SPA fallback - serve index.html for all non-API routes
    app.get('/{*splat}', (req, res, next) => {
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
