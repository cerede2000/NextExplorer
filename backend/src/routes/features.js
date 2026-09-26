const express = require('express');
const {
  onlyoffice,
  collabora,
  editor,
  terminal,
  features,
  hiddenFiles,
  public: publicConfig,
} = require('../config/index');
const terminalService = require('../services/terminalService');
const { getTrashSettings } = require('../services/trash/settings');
const { getVersionSettings } = require('../services/versions/settings');
const { MAX_UPLOAD_CHUNK_SIZE_BYTES } = require('../services/settingsService');
const { getSupportedArchiveExtensions } = require('../services/archiveService');
const packageJson = require('../../package.json');

const router = express.Router();

// GET /api/features -> returns enabled/disabled feature flags derived from env
router.get('/features', async (_req, res) => {
  // Probed once at startup, then cached — this await is effectively free.
  const archiveExtensions = await getSupportedArchiveExtensions().catch(() => ['zip']);
  const payload = {
    public: {
      url: publicConfig?.url || null,
      origin: publicConfig?.origin || null,
      // All origins the app may legitimately be reached from (public + internal).
      origins: Array.isArray(publicConfig?.origins) ? publicConfig.origins : [],
    },
    onlyoffice: {
      enabled: Boolean(onlyoffice && onlyoffice.serverUrl),
      extensions: Array.isArray(onlyoffice?.extensions) ? onlyoffice.extensions : [],
    },
    collabora: {
      enabled: Boolean(collabora && collabora.url && collabora.secret),
      extensions: Array.isArray(collabora?.extensions) ? collabora.extensions : [],
    },
    editor: {
      extensions: Array.isArray(editor?.extensions) ? editor.extensions : [],
    },
    hiddenFiles: {
      patterns: Array.isArray(hiddenFiles?.patterns) ? hiddenFiles.patterns : [],
    },
    volumeUsage: {
      enabled: Boolean(features?.volumeUsage),
    },
    // Whether deleting goes to the trash, and for how long it keeps things:
    // what the delete dialog tells people before they confirm. Nothing here
    // says what is in anyone's trash.
    trash: await getTrashSettings().then(
      (settings) => ({ enabled: settings.enabled, retentionDays: settings.retentionDays }),
      () => ({ enabled: false, retentionDays: null })
    ),
    // Whether a save keeps what it replaces. Nothing here says what any file's
    // history holds.
    versions: await getVersionSettings().then(
      (settings) => ({ enabled: settings.enabled }),
      () => ({ enabled: false })
    ),
    archives: {
      // What the 7-Zip build on this machine can actually open, rather than a
      // list kept in the browser that a different image would make wrong.
      extensions: archiveExtensions,
    },
    uploads: {
      // The ceiling an administrator may raise the chunk size to
      // (MAX_CHUNK_SIZE_MIB), so the screen can say what it is rather than
      // refusing a number without explaining.
      maxChunkSizeBytes: MAX_UPLOAD_CHUNK_SIZE_BYTES,
    },
    personal: {
      enabled: Boolean(features?.personalFolders),
    },
    userVolumes: {
      enabled: Boolean(features?.userVolumes),
    },
    navigation: {
      skipHome: Boolean(features?.skipHome),
    },
    folderSize: {
      mode: features?.folderSizeMode || 'off',
      enabled: (features?.folderSizeMode || 'off') !== 'off',
    },
    terminal: {
      enabled: Boolean(features?.terminal) && terminalService.isAvailable(),
      extensions: Array.isArray(terminal?.extensions) ? terminal.extensions : [],
    },
    version: {
      app: packageJson.version || '1.0.0',
      gitCommit: process.env.GIT_COMMIT || '',
      gitBranch: process.env.GIT_BRANCH || '',
      repoUrl: process.env.REPO_URL || '',
    },
  };

  res.json(payload);
});

module.exports = router;
