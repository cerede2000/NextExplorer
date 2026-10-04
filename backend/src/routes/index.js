const express = require('express');
const authRoutes = require('./auth');
const uploadRoutes = require('./upload');
const fileRoutes = require('./files');
const browseRoutes = require('./browse');
const thumbnailRoutes = require('./thumbnails');
const editorRoutes = require('./editor');
const volumeRoutes = require('./volumes');
const usageRoutes = require('./usage');
const folderSizeRoutes = require('./folderSize');
const favoritesRoutes = require('./favorites');
const settingsRoutes = require('./settings');
const searchRoutes = require('./search');
const usersRoutes = require('./users');
const metadataRoutes = require('./metadata');
const onlyofficeRoutes = require('./onlyoffice');
const collaboraRoutes = require('./collabora');
const featuresRoutes = require('./features');
const terminalRoutes = require('./terminal');
const permissionsRoutes = require('./permissions');
const sharesRoutes = require('./shares');
const zipRoutes = require('./zip');
const archiveRoutes = require('./archive');
const userVolumesRoutes = require('./userVolumes');
const trashRoutes = require('./trash');
const versionsRoutes = require('./versions');
const versionsAdminRoutes = require('./versionsAdmin');
const activityRoutes = require('./activity');
const capabilitiesRoutes = require('./capabilities');
const openapiRoutes = require('./openapi');
const { onlyoffice, collabora } = require('../config/index');
const { requireShareScope } = require('../middleware/shareScope');
const { requireThumbnailToken } = require('../utils/staticServer');
const { directories } = require('../config/index');

const registerRoutes = (app) => {
  // Health endpoints (no /api prefix, unauthenticated)

  app.use('/api/auth', authRoutes);
  app.use('/api', uploadRoutes);
  app.use('/api', fileRoutes);
  app.use('/api', browseRoutes);
  app.use('/api', editorRoutes);
  app.use('/api', volumeRoutes);
  app.use('/api', usageRoutes);
  app.use('/api', folderSizeRoutes);
  app.use('/api', favoritesRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', thumbnailRoutes);
  app.use('/api', searchRoutes);
  app.use('/api', usersRoutes);
  app.use('/api', metadataRoutes);
  app.use('/api', permissionsRoutes);
  app.use('/api', zipRoutes);
  app.use('/api', archiveRoutes);
  app.use('/api', trashRoutes);
  // Before the per-file routes: `/versions/admin/…` must not be read as a
  // version id with a suffix.
  app.use('/api', versionsAdminRoutes);
  app.use('/api', versionsRoutes);
  app.use('/api', activityRoutes);
  app.use('/api', capabilitiesRoutes);
  // User volumes management (admin only, requires USER_VOLUMES feature)
  app.use('/api', userVolumesRoutes);
  // Share routes (supports guest sessions)
  app.use('/api/shares', sharesRoutes);
  app.use('/api/share', sharesRoutes);

  /**
   * Everything else a share's visitor asks for, under the share's own prefix.
   *
   * The same routers, the same handlers, the same access check on the same
   * logical path — `share/<token>/…` already says which share it belongs to, and
   * that is what every one of them resolves. What changes is only the address,
   * and why it has to change is in `middleware/shareScope.js`: a visitor's
   * requests used to be scattered across the API, so letting a public link
   * through an authentication proxy meant opening `/api/download` and
   * `/api/preview` to everyone, for every file in the instance.
   *
   * Mounted after the share's own routes, which therefore keep their addresses.
   * `requireShareScope` runs first and is a narrowing: this prefix is never
   * anonymous, and a guest session is only good for the share it was issued for.
   *
   * Uploading is not here. A resumable upload is told where to send the rest of
   * itself by the answer to its first request, and that address is built inside
   * @tus/server from a path it is configured with — so moving the upload under
   * this prefix means moving it there too, which is not a change to make in
   * passing. Somebody publishing a share that accepts uploads still has to let
   * `/api/upload` through.
   */
  /**
   * A thumbnail is a file, fetched by an `<img>`, so it is served rather than
   * answered — and it carries its own proof: `/api/thumbnails` runs the access
   * check and signs the one filename it cleared, which is what this verifies.
   * Under the share prefix for the same reason as the rest, and behind the same
   * gate, so the signature is now the second lock rather than the only one.
   */
  const shareThumbnailFiles = express.Router();
  shareThumbnailFiles.use(
    '/static/thumbnails',
    requireThumbnailToken,
    express.static(directories.thumbnails)
  );

  const forShareVisitors = [
    fileRoutes,
    thumbnailRoutes,
    shareThumbnailFiles,
    metadataRoutes,
    folderSizeRoutes,
    zipRoutes,
    archiveRoutes,
  ];
  if (onlyoffice && onlyoffice.serverUrl) forShareVisitors.push(onlyofficeRoutes);
  if (collabora && collabora.url && collabora.secret) forShareVisitors.push(collaboraRoutes);
  app.use('/api/share/:shareToken', requireShareScope, ...forShareVisitors);
  // Public features endpoint (always available)
  app.use('/api', featuresRoutes);
  // The API's own description, also answered to anybody
  app.use('/api', openapiRoutes);
  // Admin-only terminal session endpoint
  app.use('/api', terminalRoutes);
  // Mount ONLYOFFICE routes only when configured
  if (onlyoffice && onlyoffice.serverUrl) {
    app.use('/api', onlyofficeRoutes);
  }

  // Mount Collabora routes only when configured
  if (collabora && collabora.url && collabora.secret) {
    app.use('/api', collaboraRoutes);
  }
};

module.exports = registerRoutes;
