const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const { onlyoffice, public: publicConfig } = require('../config/index');
const { toExtension, resolveMimeType } = require('../utils/fileTypes');
const { getDocumentType } = require('../utils/onlyofficeDocumentTypes');
const {
  normalizeRelativePath,
  combineRelativePath,
  ensureValidName,
  findAvailableName,
} = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { renameEntry } = require('../services/renameService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, UnauthorizedError, ForbiddenError } = require('../errors/AppError');
const folderSizeHooks = require('../services/folderSizeHooks');
const onlyofficeActivity = require('../services/onlyofficeActivityService');

const router = express.Router();
const pendingForceSaves = new Map();
const pendingForceSavesBySession = new Map();
const editorSessions = new Map();

const EDITOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FORCE_SAVE_RETRY_DELAYS_MS = [250, 750, 1500, 2500];

// The backend token is signed with the same secret as the Document Server
// tokens, so it carries a type claim to keep the two apart, and a lifetime
// long enough for an editing session but not indefinite.
const BACKEND_TOKEN_TYPE = 'nextexplorer-backend';
const BACKEND_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * Read a backend token from the query string.
 *
 * Returns null unless the token is valid, is a backend token (not a Document
 * Server one signed with the same secret) and carries an absolute path.
 */
const readBackendToken = (req) => {
  const raw = typeof req.query?.backend === 'string' ? req.query.backend : null;
  if (!raw || !onlyoffice.secret) return null;
  try {
    const payload = jwt.verify(raw, onlyoffice.secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object') return null;
    if (payload.typ !== BACKEND_TOKEN_TYPE) return null;
    if (typeof payload.absolutePath !== 'string' || !payload.absolutePath) return null;
    return payload;
  } catch (e) {
    logger.warn({ err: e }, 'ONLYOFFICE backend token verification failed');
    return null;
  }
};

/**
 * Document Server origins we accept a saved document from.
 *
 * The callback hands us a URL to download the edited file; without this check
 * the server would fetch any address an authorized editor asks for. Extra
 * origins can be declared when the Document Server reports itself under a
 * different host than the one we call it on.
 */
const buildAllowedDownloadOrigins = () => {
  const origins = new Set();
  const add = (value) => {
    if (!value) return;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore malformed configuration entries.
    }
  };
  add(onlyoffice.serverUrl);
  (onlyoffice.downloadOrigins || []).forEach(add);
  return origins;
};

const ensureAllowedDownloadUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new ValidationError('The document URL is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('The document URL must use HTTP or HTTPS.');
  }
  const allowed = buildAllowedDownloadOrigins();
  if (!allowed.has(parsed.origin)) {
    logger.warn(
      { origin: parsed.origin, allowed: Array.from(allowed) },
      'ONLYOFFICE callback rejected: document URL origin is not allowed. Add it to ONLYOFFICE_DOWNLOAD_ORIGINS if the Document Server reports a different host.'
    );
    throw new ForbiddenError('The document URL does not come from the configured Document Server.');
  }
  return parsed.toString();
};

/**
 * A backend token lives 12 hours; the share it was issued for may not.
 * Confirm the share still exists before honouring the token's write claim.
 */
const assertShareStillValid = async (backendCtx) => {
  if (!backendCtx?.shareToken) return;
  const { getShareByToken, isShareExpired } = require('../services/sharesService');
  const share = await getShareByToken(backendCtx.shareToken);
  if (!share || isShareExpired(share)) {
    throw new ForbiddenError('The share for this editing session is no longer available.');
  }
};

/**
 * Pull a document the Document Server prepared into a file, atomically.
 *
 * Written to a temporary name in the destination directory and renamed over
 * the target, so a slow or failed response never leaves a valid document
 * truncated to nothing. Used both when saving an edited document back over
 * itself and when saving one under a new name.
 */
const downloadDocumentTo = async (downloadUrl, targetPath, mode = 0o600) => {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.onlyoffice-${crypto.randomUUID()}.tmp`
  );

  try {
    const response = await axios.get(downloadUrl, { responseType: 'stream', timeout: 30000 });
    await pipeline(response.data, fs.createWriteStream(temporaryPath, { flags: 'wx', mode }));
    // The write stream's mode is subject to the umask; this is not.
    await fsp.chmod(temporaryPath, mode);
    await fsp.rename(temporaryPath, targetPath);
  } finally {
    await fsp.unlink(temporaryPath).catch(() => {});
  }
};

const buildDocumentKey = (relativePath, stat, documentType) =>
  crypto
    .createHash('sha256')
    .update(relativePath)
    // Keep the key stable while a document is open, but make it unambiguously
    // change after a save or an external replacement so Document Server never
    // serves an older cached revision on the next open.
    .update(String(stat.mtimeMs))
    .update(String(stat.ctimeMs))
    .update(String(stat.size))
    // The cache is keyed on this alone, and what it holds is the file as one
    // editor prepared it. An unchanged file opened with a different editor is a
    // different document: a drawing once opened as text kept answering with
    // that failed attempt, from cache, long after the mapping was corrected —
    // no conversion was even retried, so nothing appeared in the logs either.
    .update(String(documentType))
    .digest('hex');

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

const getSessionOwner = (req) => ({
  userId: req.user?.id ? String(req.user.id) : null,
  guestSessionId: req.guestSession?.id ? String(req.guestSession.id) : null,
});

const matchesSessionOwner = (session, req) => {
  const owner = getSessionOwner(req);
  return owner.userId === session.userId && owner.guestSessionId === session.guestSessionId;
};

const cleanupExpiredEditorSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of editorSessions) {
    if (session.expiresAt <= now) editorSessions.delete(sessionId);
  }
};

/**
 * Presence is deliberately not recorded here.
 *
 * This runs when the editor asks for its configuration, which says nothing
 * about whether the document will open. A file the editor then refused — a
 * drawing announced with the wrong editor, say — was still displayed as being
 * edited, by everyone, until the session expired. The client reports presence
 * once ONLYOFFICE says the document is ready, through the heartbeat below.
 */
const createEditorSession = (req, relativePath, key, absolutePath) => {
  cleanupExpiredEditorSessions();
  const sessionId = crypto.randomUUID();
  const owner = getSessionOwner(req);
  editorSessions.set(sessionId, {
    key,
    relativePath,
    // Where the document is *now*. The backend token carries the path as it
    // was when the editor opened, and renaming makes that copy wrong; a save
    // arriving afterwards would recreate the old name beside the new one.
    absolutePath,
    ...owner,
    expiresAt: Date.now() + EDITOR_SESSION_TTL_MS,
  });
  return sessionId;
};

/**
 * Where a save should be written for this token.
 *
 * The token is minted once and handed to the Document Server, which returns it
 * unchanged however long the editing session lasts. The session, which lives
 * here, is what follows the document if it is renamed meanwhile. Sessions are
 * in memory, so a restart falls back to the token — right in every case except
 * a rename that the restart also erased the record of.
 */
const resolveSaveTarget = (backendCtx) => {
  const session = backendCtx?.sessionId ? editorSessions.get(backendCtx.sessionId) : null;
  if (session?.absolutePath && session.expiresAt > Date.now()) return session.absolutePath;
  return backendCtx.absolutePath;
};

const describeSessionUser = (req) => {
  const owner = getSessionOwner(req);
  return {
    id: owner.userId || (owner.guestSessionId ? `guest_${owner.guestSessionId}` : null),
    name:
      req.user?.displayName ||
      req.user?.username ||
      (owner.guestSessionId ? 'Invité' : 'Utilisateur'),
  };
};

const getEditorSession = (req, sessionId, relativePath) => {
  cleanupExpiredEditorSessions();
  const session = editorSessions.get(sessionId);
  if (!session || session.relativePath !== relativePath || !matchesSessionOwner(session, req)) {
    throw new ForbiddenError(
      'The ONLYOFFICE editing session is no longer valid. Reopen the document.'
    );
  }
  session.expiresAt = Date.now() + EDITOR_SESSION_TTL_MS;
  return session;
};

const enqueueForceSave = ({ sessionId, key, relativePath, reason }) => {
  const requestId = `nextexplorer-force-save:${crypto.randomUUID()}`;
  const timeout = setTimeout(
    () => finishForceSave(requestId, { saved: false, timedOut: true }),
    onlyoffice.forceSaveTimeoutMs
  );
  timeout.unref?.();
  pendingForceSaves.set(requestId, {
    sessionId,
    key,
    relativePath,
    reason,
    requestedAt: Date.now(),
    timeout,
    retryTimer: null,
    followUpReason: null,
  });
  pendingForceSavesBySession.set(sessionId, requestId);

  logger.debug(
    { path: relativePath, requestId, reason },
    'ONLYOFFICE force-save accepted by NextExplorer'
  );
  setImmediate(() => {
    void dispatchForceSave({ requestId, key, relativePath, reason });
  });
  return requestId;
};

const finishForceSave = (requestId, result) => {
  if (!requestId) return;
  const pending = pendingForceSaves.get(requestId);
  if (!pending) return;
  pendingForceSaves.delete(requestId);
  if (pendingForceSavesBySession.get(pending.sessionId) === requestId) {
    pendingForceSavesBySession.delete(pending.sessionId);
  }
  clearTimeout(pending.timeout);
  if (pending.retryTimer) clearTimeout(pending.retryTimer);
  logger.debug(
    {
      requestId,
      reason: pending.reason,
      elapsedMs: Date.now() - pending.requestedAt,
      ...result,
    },
    'ONLYOFFICE force-save finished'
  );

  // A close may arrive while an automatic save is assembling an earlier
  // version. Queue one final command so the most recent edits do not rely on
  // ONLYOFFICE's delayed status-2 callback.
  if (pending.followUpReason) {
    const { sessionId, key, relativePath, followUpReason } = pending;
    logger.debug(
      { path: relativePath, requestId, reason: followUpReason },
      'ONLYOFFICE force-save scheduling follow-up request'
    );
    enqueueForceSave({ sessionId, key, relativePath, reason: followUpReason });
  }
};

const dispatchForceSave = async ({ requestId, key, relativePath, reason, attempt = 0 }) => {
  try {
    logger.debug(
      { path: relativePath, requestId, reason, attempt },
      'ONLYOFFICE force-save dispatching'
    );
    const command = {
      c: 'forcesave',
      key,
      userdata: requestId,
    };
    command.token = jwt.sign(command, onlyoffice.secret, { algorithm: 'HS256' });

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
    if (response.status >= 200 && response.status < 300 && code === 0) {
      logger.debug(
        { path: relativePath, requestId, reason, status: response.status },
        'ONLYOFFICE force-save accepted by Document Server'
      );
      return;
    }

    // Code 4 means the document editor has not yet sent its last changes to
    // Document Server. Retry server-side so closing the preview stays instant.
    if (code === 4 && attempt < FORCE_SAVE_RETRY_DELAYS_MS.length) {
      const pending = pendingForceSaves.get(requestId);
      if (!pending) return;
      pending.retryTimer = setTimeout(() => {
        void dispatchForceSave({ requestId, key, relativePath, reason, attempt: attempt + 1 });
      }, FORCE_SAVE_RETRY_DELAYS_MS[attempt]);
      pending.retryTimer.unref?.();
      return;
    }

    logger.debug(
      { path: relativePath, reason, status: response.status, code, requestId, attempt },
      'ONLYOFFICE force-save was not queued'
    );
    finishForceSave(requestId, { saved: false, code });
  } catch (err) {
    logger.warn(
      { err, path: relativePath, reason, requestId, attempt },
      'ONLYOFFICE force-save request failed'
    );
    finishForceSave(requestId, { saved: false });
  }
};

/**
 * Which ONLYOFFICE theme to dress the editor in.
 *
 * The appearance is a client preference, but it has to be decided here: the
 * Document Server reads the configuration from the signed token and ignores
 * whatever the page sets on the object afterwards. So the client sends what it
 * is currently showing, and anything unrecognised falls back to the editor's
 * own default rather than being passed through.
 */
const resolveUiTheme = (requested) => {
  if (requested === 'dark') return 'theme-dark';
  if (requested === 'light') return 'theme-light';
  return null;
};

// POST /api/onlyoffice/config  { path, mode?, theme? }
router.post(
  '/onlyoffice/config',
  asyncHandler(async (req, res) => {
    const relativeRaw = req.body?.path || '';
    const mode = (req.body?.mode || 'edit').toLowerCase();
    const uiTheme = resolveUiTheme(String(req.body?.theme || '').toLowerCase());

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

    // Disable editing for readonly shares, readonly locations, or view mode.
    // Computed before the backend token is signed: the token carries this
    // decision, so a viewer never receives one that allows writing.
    const canEdit = mode !== 'view' && !isReadonlyShare && accessInfo.canWrite === true;

    const filename = path.basename(abs);
    const ext = toExtension(filename);
    const documentType = getDocumentType(ext);
    if (!documentType) {
      // Refuse here rather than let the Document Server open it with the wrong
      // editor: the answer it gives back names the file, never the setting.
      throw new ValidationError(
        `ONLYOFFICE has no editor for .${ext} files. Remove it from ONLYOFFICE_FILE_EXTENSIONS, ` +
          'or open it with Collabora instead.'
      );
    }

    const fileUrl = new URL(`/api/onlyoffice/file`, publicConfig.url);
    fileUrl.searchParams.set('path', relativePath);

    const callbackUrl = new URL(`/api/onlyoffice/callback`, publicConfig.url);
    callbackUrl.searchParams.set('path', relativePath);

    // Unique key should change when file changes to bust DS cache
    const key = buildDocumentKey(relativePath, stat, documentType);

    // canEdit is decided above, before the backend token is signed.
    const forceSaveSessionId = canEdit ? createEditorSession(req, relativePath, key, abs) : null;

    // Backend context for storage requests (signed separately and passed via query)
    let backendToken = null;
    if (onlyoffice.secret) {
      const backendPayload = {
        typ: BACKEND_TOKEN_TYPE,
        absolutePath: abs,
        logicalPath: resolved.relativePath,
        space: resolved.space,
        // The callback trusts this flag instead of re-resolving permissions,
        // so it must reflect what this session is actually allowed to do.
        canWrite: canEdit,
        // Lets a save find the document again if it was renamed while open;
        // the path above is only what it was called when the editor started.
        sessionId: forceSaveSessionId,
        userId: req.user && req.user.id ? String(req.user.id) : null,
        guestSessionId: req.guestSession?.id || null,
        shareToken: resolved.shareInfo?.shareToken || null,
      };
      backendToken = jwt.sign(backendPayload, onlyoffice.secret, {
        algorithm: 'HS256',
        expiresIn: BACKEND_TOKEN_TTL_SECONDS,
      });
      fileUrl.searchParams.set('backend', backendToken);
      callbackUrl.searchParams.set('backend', backendToken);
    }

    const config = {
      documentType, // word | cell | slide | pdf | diagram
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
          // Let the editor draw its own close button. NextExplorer used to lay
          // one over the toolbar, which meant covering the editor's logo and
          // hoping nothing underneath moved; the client closes the preview when
          // ONLYOFFICE asks it to instead.
          close: { visible: true },
          // Omitted when the client sends no usable preference, so the editor
          // keeps its own default instead of being forced light.
          ...(uiTheme ? { uiTheme } : {}),
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
      forceSaveSessionId,
      autoSaveIntervalMs: canEdit ? onlyoffice.autoSaveIntervalMs : 0,
    });
  })
);

router.post(
  '/onlyoffice/session-heartbeat',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    const sessionId = req.body?.sessionId || '';
    if (!relativePath || typeof sessionId !== 'string' || !sessionId) {
      throw new ValidationError('A valid ONLYOFFICE editing session is required.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);
    if (!accessInfo?.canAccess || !accessInfo.canRead) throw new ForbiddenError('Access denied.');
    getEditorSession(req, sessionId, relativePath);
    // The client starts beating once ONLYOFFICE reports the document ready, so
    // the first beat is what declares the document open.
    const active = onlyofficeActivity.touch({
      absolutePath: resolved.absolutePath,
      sessionId,
      user: describeSessionUser(req),
    });
    res.json({ active });
  })
);

/**
 * Rename the open document from the editor's title bar.
 *
 * The rename itself is the ordinary one, with the ordinary permission checks.
 * What is specific here is keeping the editing session pointed at the file
 * afterwards: the Document Server holds a token naming the path as it was when
 * the editor opened, and returns it unchanged with every save. Left alone, the
 * next autosave would recreate the old name beside the new one.
 */
router.post(
  '/onlyoffice/rename',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    const sessionId = req.body?.sessionId || '';
    if (!relativePath || typeof sessionId !== 'string' || !sessionId) {
      throw new ValidationError('A valid ONLYOFFICE editing session is required.');
    }

    // Only the session that opened this document may rename it from inside the
    // editor, and only sessions allowed to write ever get one.
    const session = getEditorSession(req, sessionId, relativePath);

    const parentPath = path.posix.dirname(relativePath);
    const renamed = await renameEntry({
      context: { user: req.user, guestSession: req.guestSession },
      parentRelative: parentPath === '.' ? '' : parentPath,
      currentName: path.posix.basename(relativePath),
      newName: req.body?.newName,
    });

    if (renamed.changed) {
      // Both records follow the file: the session decides where a save lands,
      // presence decides which row shows as being edited.
      session.relativePath = renamed.relativePath;
      session.absolutePath = renamed.absolutePath;
      onlyofficeActivity.rename({
        from: renamed.previousAbsolutePath,
        to: renamed.absolutePath,
      });
    }

    res.json({ path: renamed.relativePath, name: renamed.name });
  })
);

/**
 * "Save as" from inside the editor.
 *
 * ONLYOFFICE does not write anything itself: it converts the document, then
 * hands the integration a URL to fetch the result from. Without a route to
 * receive it the menu entry is hidden, which left Download as the only way out
 * — through the browser, into the user's downloads, not their volume.
 *
 * Deliberately not tied to an editing session: saving a copy is not a change to
 * the original, so viewers may do it too. What it does require is the right to
 * read the document it came from and to write into the folder it lands in,
 * exactly as an upload would.
 */
router.post(
  '/onlyoffice/save-as',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    if (!relativePath) {
      throw new ValidationError('A valid file path is required.');
    }

    // The URL comes from the editor, so it is only ever fetched when it points
    // at the configured Document Server — same rule as the save callback.
    const downloadUrl = ensureAllowedDownloadUrl(req.body?.url);

    let desiredName;
    try {
      // Refused, not trimmed down to its last segment. A title carrying a
      // separator means the request is not what this route is for, and quietly
      // reinterpreting it would turn "../invoice.pdf" into a silent success in
      // a folder the caller never named.
      desiredName = ensureValidName(String(req.body?.title || ''));
    } catch (error) {
      throw new ValidationError(error.message);
    }

    const context = { user: req.user, guestSession: req.guestSession };

    // Reading the source is what entitles someone to save a copy of it.
    const { accessInfo: sourceAccess } = await resolvePathWithAccess(context, relativePath);
    if (!sourceAccess?.canAccess || !sourceAccess.canRead) {
      throw new ForbiddenError(sourceAccess?.denialReason || 'Access denied.');
    }

    const parentPath = path.posix.dirname(relativePath);
    const targetFolder = parentPath === '.' ? '' : parentPath;
    const { accessInfo: folderAccess, resolved: folder } = await resolvePathWithAccess(
      context,
      targetFolder
    );
    if (!folderAccess?.canAccess || !folderAccess.canWrite) {
      throw new ForbiddenError(folderAccess?.denialReason || 'Access denied.');
    }

    // A copy never overwrites: an existing name gets the same "(1)" treatment
    // as everywhere else in the app.
    const name = await findAvailableName(folder.absolutePath, desiredName);
    const absolute = path.join(folder.absolutePath, name);

    await ensureDir(folder.absolutePath);
    await downloadDocumentTo(downloadUrl, absolute);

    const written = await fsp.stat(absolute);
    await folderSizeHooks.onFileWritten(absolute, written.size);

    const savedPath = combineRelativePath(targetFolder, name);
    logger.info(
      { path: savedPath, size: written.size },
      'ONLYOFFICE document saved under a new name'
    );

    res.json({ path: savedPath, name, size: written.size });
  })
);

router.post(
  '/onlyoffice/session-close',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    const sessionId = req.body?.sessionId || '';
    if (!relativePath || typeof sessionId !== 'string' || !sessionId) {
      throw new ValidationError('A valid ONLYOFFICE editing session is required.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo } = await resolvePathWithAccess(context, relativePath);
    if (!accessInfo?.canAccess || !accessInfo.canRead) throw new ForbiddenError('Access denied.');
    getEditorSession(req, sessionId, relativePath);
    // Closing the embedded frame does not mean Document Server has released
    // the document yet. Keep the advisory activity until its status-2/4
    // callback arrives (or until the short session TTL is reached).
    editorSessions.delete(sessionId);
    res.status(204).end();
  })
);

router.get(
  '/onlyoffice/activity-version',
  asyncHandler(async (req, res) => {
    const parsedSince = Number(req.query?.since);
    const since = Number.isInteger(parsedSince) ? parsedSince : null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    req.once('close', abort);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await onlyofficeActivity.waitForChange(since, 25_000, controller.signal);
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } finally {
      req.off('aborted', abort);
      req.off('close', abort);
    }
  })
);

// Queue a save before the embedded editor is closed. The request returns right
// away: Document Server sends the actual status-6 callback asynchronously.
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
    const sessionId = req.body?.sessionId || '';
    const reason = req.body?.reason === 'auto' ? 'auto' : 'close';
    if (typeof relativeRaw !== 'string' || !relativeRaw.trim()) {
      throw new ValidationError('A valid file path is required.');
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new ValidationError('A valid ONLYOFFICE editing session is required.');
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

    const session = getEditorSession(req, sessionId, relativePath);
    const existingRequestId = pendingForceSavesBySession.get(sessionId);
    const pending = existingRequestId ? pendingForceSaves.get(existingRequestId) : null;
    if (pending) {
      const followUp = reason === 'close' && pending.reason === 'auto';
      if (followUp) pending.followUpReason = 'close';
      logger.debug(
        { path: relativePath, requestId: existingRequestId, reason, followUp },
        'ONLYOFFICE force-save coalesced with pending request'
      );
      return res.status(202).json({
        queued: true,
        requestId: existingRequestId,
        coalesced: true,
        followUp,
      });
    }

    const requestId = enqueueForceSave({
      sessionId,
      key: session.key,
      relativePath,
      reason,
    });
    res.status(202).json({ queued: true, requestId });
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
    const backendCtx = readBackendToken(req);

    // Determine absolute path:
    // - Prefer signed backend context when available (works for personal/share paths)
    // - Fallback to resolving logical path without user for volume-only paths
    let abs = null;
    if (backendCtx) {
      abs = resolveSaveTarget(backendCtx);
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
    const ext = toExtension(abs);
    const mime = resolveMimeType(ext);
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
      const backendCtx = readBackendToken(req);

      const body = req.body || {};
      const status = Number(body.status);
      forceSaveRequestId = typeof body.userdata === 'string' ? body.userdata : null;
      const activityPath = backendCtx?.absolutePath;

      // Status 1 reports the users currently connected to the document. It is
      // presence only: this never becomes a filesystem lock and expires if
      // Document Server stops sending callbacks.
      if (status === 1 && activityPath) {
        onlyofficeActivity.updateDocumentServerUsers({
          absolutePath: activityPath,
          users: Array.isArray(body.users) ? body.users : [],
        });
      } else if ((status === 2 || status === 4) && activityPath) {
        onlyofficeActivity.release({ absolutePath: activityPath });
      }

      if (status === 7) {
        finishForceSave(forceSaveRequestId, { saved: false, failed: true });
        logger.warn({ path: relativePath, forceSaveRequestId }, 'ONLYOFFICE force-save failed');
        return res.json({ error: 0 });
      }
      // See ONLYOFFICE callback statuses: 2 - Save, 6 - Force Save
      if ((status === 2 || status === 6) && body.url) {
        // The Document Server hands us a URL to pull the saved document from.
        // Only the configured server may be contacted.
        const downloadUrl = ensureAllowedDownloadUrl(body.url);
        let abs = null;
        if (backendCtx) {
          // The token stands in for a permission check, so it only counts when
          // the session it was issued for was allowed to write.
          if (backendCtx.canWrite !== true) {
            throw new ForbiddenError('This editing session is read-only.');
          }
          await assertShareStillValid(backendCtx);
          abs = resolveSaveTarget(backendCtx);
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
        let previousMode = 0o600;
        let existed = false;
        try {
          const previous = await fsp.stat(abs);
          existed = previous.isFile();
          previousSize = existed ? previous.size : 0;
          previousMode = previous.mode & 0o777;
        } catch {
          // A newly-created document is valid.
        }
        // Keep the permissions the document already had; a new one starts
        // private.
        await downloadDocumentTo(downloadUrl, abs, existed ? previousMode : 0o600);
        const updated = await fsp.stat(abs);
        if (existed) {
          await folderSizeHooks.onFileReplaced(abs, previousSize, updated.size);
        } else {
          await folderSizeHooks.onFileWritten(abs, updated.size);
        }
        finishForceSave(forceSaveRequestId, { saved: status === 6 });
        logger.debug(
          {
            path: relativePath,
            status,
            forceSaveType: body.forcesavetype,
            forceSaveRequestId,
            size: updated.size,
          },
          'ONLYOFFICE file updated'
        );
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
