const express = require('express');
const {
  onlyoffice,
  collabora,
  editor,
  terminal,
  features,
  public: publicConfig,
} = require('../config/index');
const terminalService = require('../services/terminalService');
const { MAX_UPLOAD_CHUNK_SIZE_BYTES } = require('../services/settingsService');
const packageJson = require('../../package.json');

const router = express.Router();

// GET /api/features -> returns enabled/disabled feature flags derived from env
router.get('/features', (_req, res) => {
  const payload = {
    public: {
      url: publicConfig?.url || null,
      origin: publicConfig?.origin || null,
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
    uploads: {
      // Admin-configurable upper bound for the chunk size (env MAX_CHUNK_SIZE_MIB).
      maxChunkSizeBytes: MAX_UPLOAD_CHUNK_SIZE_BYTES,
    },
    volumeUsage: {
      enabled: Boolean(features?.volumeUsage),
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
