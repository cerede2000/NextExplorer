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
 * answers "does this file exist". Requiring a session keeps them off the
 * anonymous internet without changing any URL, so existing cached thumbnails
 * stay valid (salting the hash would invalidate every one of them).
 */
const requireSession = async (req, res, next) => {
  if (auth.enabled === false) return next();

  // The auth middleware only runs on /api, so nothing is attached here yet.
  // The session cookie itself is already loaded by express-session, so the
  // common case (a signed-in user) costs nothing extra.
  if (req.session?.localUserId || req.oidc?.isAuthenticated?.()) return next();

  // Share visitors carry a guest session instead; that one has to be looked
  // up, but a local SQLite read is cheap and only happens for guests.
  const guestSessionId = req.cookies?.guestSession || req.headers['x-guest-session'];
  if (guestSessionId) {
    try {
      const { getGuestSession } = require('../services/guestSessionService');
      if (await getGuestSession(guestSessionId)) return next();
    } catch (error) {
      logger.debug({ err: error }, 'Guest session lookup failed for a thumbnail request');
    }
  }

  res.status(401).end();
};

/**
 * Configures static file serving for thumbnails, logos, and frontend
 */
const configureStaticFiles = (app) => {
  // Serve thumbnails
  app.use('/static/thumbnails', requireSession, express.static(directories.thumbnails));
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
    app.get('*', (req, res, next) => {
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
