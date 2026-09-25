const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const { onlyoffice, public: publicConfig, mimeTypes } = require('../config/index');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const versions = require('../services/versions/operations');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, UnauthorizedError, ForbiddenError } = require('../errors/AppError');

const router = express.Router();

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

/**
 * Pull the saved document into a file of its own, next to the document.
 *
 * Never into the document itself: it used to be truncated to nothing before
 * the Document Server had answered, so a slow network, a restart or a refused
 * download left an empty file where the work had been. The versions place the
 * temporary file over the document once it is whole.
 */
const fetchDocumentInto = async (downloadUrl, temporaryPath, mode) => {
  const response = await axios.get(downloadUrl, { responseType: 'stream', timeout: 30000 });
  await pipeline(response.data, fs.createWriteStream(temporaryPath, { flags: 'wx', mode }));
  // The write stream's mode is subject to the umask; this is not.
  await fsp.chmod(temporaryPath, mode);
};

/**
 * Who a callback is saving for.
 *
 * The Document Server names the people whose changes are in this save; the
 * last of them is the one to credit. It says nothing when a save carries no
 * history — the first one of a session — and then the account the editing
 * session was opened for is the answer. Somebody who came through a share link
 * is credited as the link: there is no account to name.
 */
const authorFromCallback = (body, backendCtx) => {
  const changes = Array.isArray(body?.history?.changes) ? body.history.changes : [];
  const user = changes.length ? changes[changes.length - 1]?.user : null;
  const id = user?.id ? String(user.id) : backendCtx?.userId || null;
  if ((id && id.startsWith('guest_')) || (!id && backendCtx?.guestSessionId)) {
    return { id: null, label: 'share-link' };
  }
  return { id, label: user?.name ? String(user.name) : null };
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
    const key = crypto
      .createHash('sha256')
      .update(relativePath)
      .update(String(stat.mtimeMs))
      .digest('hex');

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

        // Keep the permissions the document already had; one the editor is
        // creating starts private.
        let mode = 0o600;
        try {
          const previous = await fsp.stat(abs);
          if (previous.isFile()) mode = previous.mode & 0o777;
        } catch {
          // A document that is not there yet has nothing to keep.
        }

        // A save on purpose — the editor's own Save, or the last one made once
        // everybody has left the document — is a state worth keeping. The
        // automatic saves in between are not, beyond the checkpoint the
        // versions take of a session that runs long.
        const explicit = status === 2 || Number(body.forcesavetype) === 1;

        await versions.saveFile(
          abs,
          (temporaryPath) => fetchDocumentInto(body.url, temporaryPath, mode),
          {
            purpose: 'onlyoffice',
            author: authorFromCallback(body, backendCtx),
            source: 'onlyoffice',
            session: {
              // Everybody editing together shares the document key: it is the
              // session, and its saves belong to it rather than each standing
              // as a state of its own.
              key: typeof body.key === 'string' && body.key ? body.key : null,
              startedAt: Number.isFinite(backendCtx?.iat) ? backendCtx.iat * 1000 : null,
            },
            explicit,
          }
        );
        logger.debug({ path: relativePath, status }, 'ONLYOFFICE file updated');
        // MUST return {error:0} according to ONLYOFFICE spec
        return res.json({ error: 0 });
      }

      // For other statuses, acknowledge
      return res.json({ error: 0 });
    } catch (err) {
      logger.error({ err }, 'ONLYOFFICE callback failed');
      // Per spec, non-zero error indicates retry; use 1
      return res.status(200).json({ error: 1 });
    }
  })
);

module.exports = router;
