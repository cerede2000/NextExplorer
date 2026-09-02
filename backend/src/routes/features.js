const express = require('express');
const {
  onlyoffice,
  collabora,
  editor,
  preview,
  search,
  terminal,
  features,
  hiddenFiles,
  public: publicConfig,
  demoLogin,
} = require('../config/index');
const terminalService = require('../services/terminalService');
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
    // Null unless demo mode is on and demo credentials were set for it. The
    // config layer is the single place that decides; there is no second rule
    // here to drift from it.
    demoLogin: demoLogin ? { email: demoLogin.email, password: demoLogin.password } : null,
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
      // What the editor will open. The preview has a limit of its own, and a
      // refusal that names both is the difference between an explanation and
      // a dead end.
      maxFileSizeBytes: editor?.maxFileSizeBytes ?? null,
    },
    preview: {
      maxRenderBytes: preview?.maxRenderBytes ?? null,
    },
    search: {
      // Whether the full-text index is on. The exclusions page is otherwise a
      // form for a feature that is not running, which nothing on it would say.
      index: { enabled: search?.index?.enabled === true },
    },
    hiddenFiles: {
      patterns: Array.isArray(hiddenFiles?.patterns) ? hiddenFiles.patterns : [],
    },
    uploads: {
      // Admin-configurable upper bound for the chunk size (env MAX_CHUNK_SIZE_MIB).
      maxChunkSizeBytes: MAX_UPLOAD_CHUNK_SIZE_BYTES,
    },
    archives: {
      // Extraction formats the server-side 7-Zip build actually supports.
      extensions: archiveExtensions,
    },
    volumeUsage: {
      enabled: Boolean(features?.volumeUsage),
    },
    folderSize: {
      mode: features?.folderSizeMode || 'off',
      enabled: (features?.folderSizeMode || 'off') !== 'off',
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
