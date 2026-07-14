const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const { onlyoffice, public: publicConfig, mimeTypes } = require('../config/index');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, UnauthorizedError, ForbiddenError } = require('../errors/AppError');
const folderSizeHooks = require('../services/folderSizeHooks');

const router = express.Router();
const pendingForceSaves = new Map();

// Helpers
const SUPPORTED_TEXT = new Set(['docx', 'doc', 'odt', 'rtf', 'txt']);
const SUPPORTED_SHEET = new Set(['xlsx', 'xls', 'ods', 'csv']);
const SUPPORTED_PRESENTATION = new Set(['pptx', 'ppt', 'odp']);

const toExt = (filename = '') => String(filename).split('.').pop().toLowerCase();

const getDocumentType = (ext) => {
  // ONLYOFFICE expects: 'word' | 'cell' | 'slide'
  if (SUPPORTED_TEXT.has(ext)) return 'word';
  if (SUPPORTED_SHEET.has(ext)) return 'cell';
  if (SUPPORTED_PRESENTATION.has(ext)) return 'slide';
  return 'word';
};

const resolveMime = (ext) => mimeTypes[ext] || 'application/octet-stream';

const buildDocumentKey = (relativePath, stat) =>
  crypto.createHash('sha256').update(relativePath).update(String(stat.mtimeMs)).digest('hex');

const getCommandServiceUrl = (key, legacy = false) => {
  const commandUrl = new URL(
    legacy ? 'coauthoring/CommandService.ashx' : 'command',
    `${onlyoffice.serverUrl.replace(/\/+$/, '')}/`
  );
  if (!legacy) commandUrl.searchParams.set('shardkey', key);
  return commandUrl.toString();
};

const getDsJwtFromReq = (req) => {
  const auth = (req.headers['authorization'] || req.headers['authorizationjwt'] || '').toString();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const q = req.query || {};
  if (typeof q.token === 'string' && q.token) return q.token;
  if (typeof q.jwt === 'string' && q.jwt) return q.jwt;
  return null;
};

const waitForForceSave = (requestId) => {
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const timeout = setTimeout(() => {
    if (!pendingForceSaves.has(requestId)) return;
    pendingForceSaves.delete(requestId);
    resolveCompletion({ saved: false, timedOut: true });
  }, onlyoffice.forceSaveTimeoutMs);

  pendingForceSaves.set(requestId, { resolveCompletion, timeout });
  return completion;
};

const finishForceSave = (requestId, result) => {
  if (!requestId) return;
  const pending = pendingForceSaves.get(requestId);
  if (!pending) return;
  pendingForceSaves.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolveCompletion(result);
};

// POST /api/onlyoffice/config  { path, mode? }
router.post(
  '/onlyoffice/config',
  asyncHandler(async (req, res) => {
    const relativeRaw = req.body?.path || '';
    const mode = (req.body?.mode || 'edit').toLowerCase();

    if (!publicConfig?.url) {
      throw new ValidationError(
        'PUBLIC_URL is required on the server to build absolute URLs for ONLYOFFICE.'
      );
    }
    if (!onlyoffice.serverUrl) {
      throw new ValidationError('ONLYOFFICE_URL is not configured on the server.');
    }

    if (typeof relativeRaw !== 'string' || !relativeRaw.trim()) {
      throw new ValidationError('A valid file path is required.');
    }

    const relativePath = normalizeRelativePath(relativeRaw);
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
    }
    const abs = resolved.absolutePath;
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      throw new ValidationError('Cannot open a directory in ONLYOFFICE.');
    }

    // Check if this is a readonly share
    const isReadonlyShare = resolved.shareInfo && resolved.shareInfo.accessMode === 'readonly';

    const filename = path.basename(abs);
    const ext = toExt(filename);
    const documentType = getDocumentType(ext);

    const fileUrl = new URL(`/api/onlyoffice/file`, publicConfig.url);
    fileUrl.searchParams.set('path', relativePath);

    const callbackUrl = new URL(`/api/onlyoffice/callback`, publicConfig.url);
    callbackUrl.searchParams.set('path', relativePath);

    // Backend context for storage requests (signed separately and passed via query)
    let backendToken = null;
    if (onlyoffice.secret) {
      const backendPayload = {
        absolutePath: abs,
        logicalPath: resolved.relativePath,
        space: resolved.space,
        userId: req.user && req.user.id ? String(req.user.id) : null,
        guestSessionId: req.guestSession?.id || null,
        shareToken: resolved.shareInfo?.shareToken || null,
      };
      backendToken = jwt.sign(backendPayload, onlyoffice.secret, {
        algorithm: 'HS256',
      });
      fileUrl.searchParams.set('backend', backendToken);
      callbackUrl.searchParams.set('backend', backendToken);
    }

    // Unique key should change when file changes to bust DS cache
    const key = buildDocumentKey(relativePath, stat);

    // Disable editing for readonly shares or when mode is view
    const canEdit = mode !== 'view' && !isReadonlyShare;

    const config = {
      documentType, // text | spreadsheet | presentation
      type: 'desktop',
      document: {
        fileType: ext,
        key,
        title: filename,
        url: fileUrl.toString(),
        permissions: {
          edit: canEdit,
          download: true,
          print: true,
          review: canEdit,
        },
      },
      editorConfig: {
        mode: canEdit ? 'edit' : 'view',
        callbackUrl: callbackUrl.toString(),
        customization: {
          anonymous: { request: false },
          // Expose ONLYOFFICE's Save action as a force-save when explicitly
          // requested. Closing the editor is handled by the route below.
          forcesave: Boolean(onlyoffice.forceSave && canEdit),
        },
        lang: onlyoffice.lang || 'en',
        // Optionally attach current user info if available
        user:
          req.user && req.user.id
            ? {
                id: String(req.user.id),
                name: req.user.displayName || req.user.username || 'User',
              }
            : req.guestSession
              ? {
                  id: `guest_${req.guestSession.id}`,
                  name: 'Guest User',
                }
              : undefined,
      },
    };

    // Sign config for Document Server when ONLYOFFICE JWT is enabled
    if (onlyoffice.secret) {
      try {
        // Important: sign the final config as-is; do not mutate URLs afterwards
        const token = jwt.sign(config, onlyoffice.secret, {
          algorithm: 'HS256',
        });
        config.token = token;
      } catch (e) {
        logger.warn({ err: e }, 'ONLYOFFICE: failed to sign config token');
      }
    }

    res.json({
      documentServerUrl: onlyoffice.serverUrl,
      config,
    });
  })
);

// Request an immediate save before the embedded editor is closed. ONLYOFFICE
// normally waits for its server-side save timeout after the final user leaves,
// which makes a freshly edited document look stale for several seconds.
router.post(
  '/onlyoffice/force-save',
  asyncHandler(async (req, res) => {
    if (!onlyoffice.serverUrl) {
      throw new ValidationError('ONLYOFFICE_URL is not configured on the server.');
    }
    if (!onlyoffice.secret) {
      throw new ValidationError('ONLYOFFICE_SECRET is required to force-save documents.');
    }

    const relativeRaw = req.body?.path || '';
    if (typeof relativeRaw !== 'string' || !relativeRaw.trim()) {
      throw new ValidationError('A valid file path is required.');
    }

    const relativePath = normalizeRelativePath(relativeRaw);
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canWrite) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
    }

    const stat = await fsp.stat(resolved.absolutePath);
    if (stat.isDirectory()) {
      throw new ValidationError('Cannot force-save a directory.');
    }

    const key = buildDocumentKey(relativePath, stat);
    const requestId = `nextexplorer-force-save:${crypto.randomUUID()}`;
    const completion = waitForForceSave(requestId);
    const command = {
      c: 'forcesave',
      key,
      userdata: requestId,
    };
    command.token = jwt.sign(command, onlyoffice.secret, { algorithm: 'HS256' });

    try {
      let response = await axios.post(getCommandServiceUrl(key), command, {
        timeout: 8000,
        validateStatus: () => true,
      });
      // ONLYOFFICE Docs 8.2 introduced /command. Keep legacy Document Server
      // installations working when they explicitly report the new route absent.
      if (response.status === 404) {
        response = await axios.post(getCommandServiceUrl(key, true), command, {
          timeout: 8000,
          validateStatus: () => true,
        });
      }
      const code = Number(response.data?.error ?? 0);

      // 1 means that the document is no longer active and 4 that it contains
      // no unsaved changes. In both cases the regular close callback remains
      // the safe fallback, so closing the preview must stay uneventful.
      if (response.status < 200 || response.status >= 300 || code !== 0) {
        finishForceSave(requestId, { saved: false, code });
        logger.debug(
          { path: relativePath, status: response.status, code, requestId },
          'ONLYOFFICE force-save was not queued'
        );
        return res.json({ queued: false, code });
      }

      logger.debug({ path: relativePath, requestId }, 'ONLYOFFICE force-save queued');
      const result = await completion;
      return res.json({ queued: true, ...result });
    } catch (err) {
      finishForceSave(requestId, { saved: false });
      // The normal status-2 callback still persists the document after the
      // Document Server timeout. Do not turn a best-effort acceleration into
      // a user-visible close failure.
      logger.warn({ err, path: relativePath }, 'ONLYOFFICE force-save request failed');
      return res.json({ queued: false });
    }
  })
);

// GET /api/onlyoffice/file?path=...
router.get(
  '/onlyoffice/file',
  asyncHandler(async (req, res) => {
    const relativeRaw = req.query?.path || '';
    if (typeof relativeRaw !== 'string' || !relativeRaw.trim()) {
      throw new ValidationError('Path is required.');
    }
    const relativePath = normalizeRelativePath(relativeRaw);
    // Verify DS JWT if configured
    if (onlyoffice.secret) {
      const token = getDsJwtFromReq(req);
      if (!token) {
        throw new UnauthorizedError('Missing token.');
      }
      try {
        jwt.verify(token, onlyoffice.secret, { algorithms: ['HS256'] });
      } catch (e) {
        throw new UnauthorizedError('Invalid token.');
      }
    }

    // Optionally, resolve from backend token (supports personal paths)
    let backendCtx = null;
    const backendToken = typeof req.query?.backend === 'string' ? req.query.backend : null;
    if (backendToken && onlyoffice.secret) {
      try {
        const payload = jwt.verify(backendToken, onlyoffice.secret, {
          algorithms: ['HS256'],
        });
        if (payload && typeof payload === 'object' && payload.absolutePath) {
          backendCtx = payload;
        }
      } catch (e) {
        logger.warn({ err: e }, 'ONLYOFFICE backend token verification failed');
      }
    }

    // Determine absolute path:
    // - Prefer signed backend context when available (works for personal/share paths)
    // - Fallback to resolving logical path without user for volume-only paths
    let abs = null;
    if (backendCtx && typeof backendCtx.absolutePath === 'string' && backendCtx.absolutePath) {
      abs = backendCtx.absolutePath;
    } else {
      const context = { user: req.user, guestSession: req.guestSession };
      const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

      if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
        throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
      }

      abs = resolved.absolutePath;
    }

    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      throw new ValidationError('Cannot fetch a directory.');
    }
    const ext = toExt(abs);
    const mime = resolveMime(ext);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
    });
    const stream = fs.createReadStream(abs);
    stream.on('error', (e) => {
      logger.error({ err: e }, 'ONLYOFFICE file stream failed');
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  })
);

// POST /api/onlyoffice/callback?path=...
router.post(
  '/onlyoffice/callback',
  asyncHandler(async (req, res) => {
    let forceSaveRequestId = null;
    try {
      const relativeRaw = req.query?.path || '';
      if (typeof relativeRaw !== 'string' || !relativeRaw.trim()) {
        throw new ValidationError('Path is required.');
      }
      const relativePath = normalizeRelativePath(relativeRaw);
      // Verify DS JWT if configured
      if (onlyoffice.secret) {
        const token = getDsJwtFromReq(req);
        if (!token) {
          throw new UnauthorizedError('Missing token.');
        }
        try {
          jwt.verify(token, onlyoffice.secret, { algorithms: ['HS256'] });
        } catch (e) {
          throw new UnauthorizedError('Invalid token.');
        }
      }

      // Optionally, resolve from backend token (supports personal paths)
      let backendCtx = null;
      const backendToken = typeof req.query?.backend === 'string' ? req.query.backend : null;
      if (backendToken && onlyoffice.secret) {
        try {
          const payload = jwt.verify(backendToken, onlyoffice.secret, {
            algorithms: ['HS256'],
          });
          if (payload && typeof payload === 'object' && payload.absolutePath) {
            backendCtx = payload;
          }
        } catch (e) {
          logger.warn({ err: e }, 'ONLYOFFICE backend token verification failed (callback)');
        }
      }

      const body = req.body || {};
      const status = Number(body.status);
      forceSaveRequestId = typeof body.userdata === 'string' ? body.userdata : null;

      if (status === 7) {
        finishForceSave(forceSaveRequestId, { saved: false, failed: true });
        logger.warn({ path: relativePath, forceSaveRequestId }, 'ONLYOFFICE force-save failed');
        return res.json({ error: 0 });
      }
      // See ONLYOFFICE callback statuses: 2 - Save, 6 - Force Save
      if ((status === 2 || status === 6) && body.url) {
        let abs = null;
        if (backendCtx && typeof backendCtx.absolutePath === 'string' && backendCtx.absolutePath) {
          abs = backendCtx.absolutePath;
        } else {
          const context = { user: req.user, guestSession: req.guestSession };
          const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

          if (!accessInfo || !accessInfo.canAccess || !accessInfo.canWrite) {
            throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
          }

          abs = resolved.absolutePath;
        }
        await ensureDir(path.dirname(abs));
        let previousSize = 0;
        let existed = false;
        try {
          const previous = await fsp.stat(abs);
          existed = previous.isFile();
          previousSize = existed ? previous.size : 0;
        } catch {
          // A newly-created document is valid.
        }
        // Download updated file from Document Server
        const response = await axios.get(body.url, { responseType: 'stream' });
        await fsp.writeFile(abs, Buffer.from([])); // ensure file exists / truncate
        const writeStream = fs.createWriteStream(abs);
        await new Promise((resolve, reject) => {
          response.data.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
        const updated = await fsp.stat(abs);
        if (existed) {
          await folderSizeHooks.onFileReplaced(abs, previousSize, updated.size);
        } else {
          await folderSizeHooks.onFileWritten(abs, updated.size);
        }
        finishForceSave(forceSaveRequestId, { saved: status === 6 });
        logger.debug({ path: relativePath, status, forceSaveRequestId }, 'ONLYOFFICE file updated');
        // MUST return {error:0} according to ONLYOFFICE spec
        return res.json({ error: 0 });
      }

      if (status === 6) {
        finishForceSave(forceSaveRequestId, { saved: false, failed: true });
      }

      // For other statuses, acknowledge
      return res.json({ error: 0 });
    } catch (err) {
      finishForceSave(forceSaveRequestId, { saved: false, failed: true });
      logger.error({ err }, 'ONLYOFFICE callback failed');
      // Per spec, non-zero error indicates retry; use 1
      return res.status(200).json({ error: 1 });
    }
  })
);

module.exports = router;
