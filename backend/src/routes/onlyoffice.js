const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const { onlyoffice, public: publicConfig, mimeTypes } = require('../config/index');
const {
  combineRelativePath,
  ensureValidName,
  normalizeRelativePath,
} = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { placeWithoutOverwrite } = require('../utils/placeWithoutOverwrite');
const { track: trackInFlight } = require('../services/inFlightFiles');
const { resolvePathWithAccess } = require('../services/accessManager');
const { renameEntry } = require('../services/renameService');
const versions = require('../services/versions/operations');
const onlyofficeActivity = require('../services/onlyofficeActivityService');
const documentKeys = require('../services/onlyofficeDocumentKeyService');
const editorSessions = require('../services/onlyofficeEditorSessionService');
const { getDocumentType } = require('../utils/onlyofficeDocumentTypes');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, UnauthorizedError, ForbiddenError } = require('../errors/AppError');

const router = express.Router();

// The backend token is signed with the same secret as the Document Server
// tokens, so it carries a type claim to keep the two apart, and a lifetime long
// enough for an editing session but not indefinite. It used to have neither: a
// token from the Document Server would have been accepted as one of ours, and
// one of ours never expired.
const BACKEND_TOKEN_TYPE = 'nextexplorer-backend';
const BACKEND_TOKEN_TTL_SECONDS = 12 * 60 * 60;

// In-flight force-save requests only: these are meaningless once the process
// that issued them is gone, unlike the sessions they refer to.
const pendingForceSaves = new Map();
const pendingForceSavesBySession = new Map();

const FORCE_SAVE_RETRY_DELAYS_MS = [250, 750, 1500, 2500];

// Helpers
const toExt = (filename = '') => String(filename).split('.').pop().toLowerCase();

const resolveMime = (ext) => mimeTypes[ext] || 'application/octet-stream';

/**
 * The addresses a saved document may be fetched from.
 *
 * The Document Server's own, and any declared beside it: behind a proxy or
 * inside a container network it sometimes reports itself under a host other
 * than the one it is called on.
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

/**
 * The callback says where to fetch the saved document from, and the server
 * fetched whatever it was told to: an address on the machine itself, or inside
 * the network the container sits in, reached by anyone who can reach the
 * callback. It has to come from the Document Server we sent the document to.
 */
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
/**
 * Pull a document the Document Server prepared into a new file in `directory`.
 *
 * Never over anything: a name already taken, before the download or during it,
 * gets the same "(1)" treatment as everywhere else, and the caller is told the
 * name actually used.
 */
const downloadDocumentInto = async (downloadUrl, directory, desiredName, mode = 0o600) => {
  const temporaryPath = path.join(
    directory,
    `.${desiredName}.onlyoffice-${crypto.randomUUID()}.tmp`
  );

  const inFlight = trackInFlight(temporaryPath, 'temporary-file');
  try {
    await fetchDocumentInto(downloadUrl, temporaryPath, mode);
    return await placeWithoutOverwrite(temporaryPath, directory, desiredName);
  } finally {
    await fsp.unlink(temporaryPath).catch(() => {});
    inFlight.release();
  }
};

const authorFromCallback = (body, backendCtx) => {
  const changes = Array.isArray(body?.history?.changes) ? body.history.changes : [];
  const user = changes.length ? changes[changes.length - 1]?.user : null;
  const id = user?.id ? String(user.id) : backendCtx?.userId || null;
  if ((id && id.startsWith('guest_')) || (!id && backendCtx?.guestSessionId)) {
    return { id: null, label: 'share-link' };
  }
  return { id, label: user?.name ? String(user.name) : null };
};

/**
 * Read a backend token from the query string.
 *
 * Returns null unless the token is valid, is a backend token — not a Document
 * Server one signed with the same secret — and carries an absolute path.
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
  } catch (error) {
    logger.warn({ err: error }, 'ONLYOFFICE backend token verification failed');
    return null;
  }
};

/**
 * A backend token lives twelve hours; the share it was issued for may not.
 * Confirm the share still exists before honouring the token's write claim.
 */
const assertShareStillValid = async (backendCtx) => {
  if (!backendCtx?.shareToken) return;
  // Required here rather than at the top: the shares service reaches back into
  // routes for its own helpers.
  // eslint-disable-next-line global-require
  const { getShareByToken, isShareExpired } = require('../services/sharesService');
  const share = await getShareByToken(backendCtx.shareToken);
  if (!share || isShareExpired(share)) {
    throw new ForbiddenError('The share for this editing session is no longer available.');
  }
};

const getSessionOwner = (req) => ({
  userId: req.user?.id ? String(req.user.id) : null,
  guestSessionId: req.guestSession?.id ? String(req.guestSession.id) : null,
});

const matchesSessionOwner = (session, req) => {
  const owner = getSessionOwner(req);
  return owner.userId === session.userId && owner.guestSessionId === session.guestSessionId;
};

const describeSessionUser = (req) => {
  const owner = getSessionOwner(req);
  return {
    id: owner.userId || (owner.guestSessionId ? `guest_${owner.guestSessionId}` : null),
    name: req.user?.displayName || req.user?.username || (owner.guestSessionId ? 'Guest' : 'User'),
  };
};

const getCommandServiceUrl = (key, legacy = false) => {
  const commandUrl = new URL(
    legacy ? 'coauthoring/CommandService.ashx' : 'command',
    `${onlyoffice.serverUrl.replace(/\/+$/, '')}/`
  );
  if (!legacy) commandUrl.searchParams.set('shardkey', key);
  return commandUrl.toString();
};

/**
 * Ask the Document Server to write what the editor holds, now.
 *
 * Closing the preview used to rely on the status-2 callback the Document Server
 * sends when it decides the document is finished with, which arrives seconds
 * later — long enough for the folder to be listed again with the old content,
 * and for the tab to be gone before anything was written.
 */
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
    { requestId, reason: pending.reason, elapsedMs: Date.now() - pending.requestedAt, ...result },
    'ONLYOFFICE force-save finished'
  );

  // A close may arrive while an automatic save is still assembling an earlier
  // version. Queue one final command so the most recent edits do not depend on
  // the delayed callback.
  if (pending.followUpReason) {
    const { sessionId, key, relativePath, followUpReason } = pending;
    enqueueForceSave({ sessionId, key, relativePath, reason: followUpReason });
  }
};

const dispatchForceSave = async ({ requestId, key, relativePath, reason, attempt = 0 }) => {
  try {
    const command = { c: 'forcesave', key, userdata: requestId };
    command.token = jwt.sign(command, onlyoffice.secret, { algorithm: 'HS256' });

    let response = await axios.post(getCommandServiceUrl(key), command, {
      timeout: 8000,
      validateStatus: () => true,
    });
    // ONLYOFFICE Docs 8.2 introduced /command. Keep older Document Server
    // installations working when they explicitly report the new route absent.
    if (response.status === 404) {
      response = await axios.post(getCommandServiceUrl(key, true), command, {
        timeout: 8000,
        validateStatus: () => true,
      });
    }

    const code = Number(response.data?.error ?? 0);
    if (response.status >= 200 && response.status < 300 && code === 0) return;

    // Code 4 means the editor has not yet sent its last changes to the Document
    // Server. Retried here so that closing the preview stays instant.
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
 * The key to hand this editor.
 *
 * Whether anyone currently has the document open is what separates "the file
 * changed because we are editing it" from "the file changed while nobody was
 * looking": the first must keep the key, the second must not.
 */
const resolveKeyForOpen = async ({ absolutePath, relativePath, stat, documentType }) => {
  const presence = onlyofficeActivity.get(absolutePath);
  return documentKeys.resolveDocumentKey({
    relativePath,
    stat,
    documentType,
    inUse: Boolean(presence?.active),
  });
};

/**
 * Presence is deliberately not recorded here.
 *
 * This runs when the editor asks for its configuration, which says nothing
 * about whether the document will open. A file the editor then refused — a
 * drawing announced with the wrong editor, say — would still be displayed as
 * being edited, by everyone, until the session expired. The client reports
 * presence once ONLYOFFICE says the document is ready, through the heartbeat.
 */
const createEditorSession = async (req, relativePath, key, absolutePath) => {
  void editorSessions.purgeExpired();
  const sessionId = crypto.randomUUID();
  await editorSessions.create({
    sessionId,
    key,
    relativePath,
    // Where the document is *now*. The backend token carries the path as it was
    // when the editor opened, and renaming makes that copy wrong; a save
    // arriving afterwards would recreate the old name beside the new one.
    absolutePath,
    ...getSessionOwner(req),
  });
  return sessionId;
};

const getEditorSession = async (req, sessionId, relativePath) => {
  const session = await editorSessions.get(sessionId);
  if (!session || session.relativePath !== relativePath || !matchesSessionOwner(session, req)) {
    throw new ForbiddenError(
      'The ONLYOFFICE editing session is no longer valid. Reopen the document.'
    );
  }
  await editorSessions.touch(sessionId);
  return session;
};

/**
 * Where a save should be written for this token.
 *
 * The token is minted once and handed to the Document Server, which returns it
 * unchanged however long the editing session lasts. The session is what follows
 * the document if it is renamed meanwhile — and it is stored, so a restart does
 * not forget the rename and put the save back under the old name. The token
 * remains the fallback for a session that has genuinely expired.
 */
const resolveSaveTarget = async (backendCtx) => {
  const session = backendCtx?.sessionId ? await editorSessions.get(backendCtx.sessionId) : null;
  return session?.absolutePath || backendCtx.absolutePath;
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

    // An earlier version, opened to be read: a viewer with nothing to save, and
    // a key of its own so it never touches the one the document is open under.
    const requestedVersion = typeof req.body?.versionId === 'string' ? req.body.versionId : '';
    if (requestedVersion) {
      res.json(await versionViewConfig(req, relativePath, requestedVersion, null));
      return;
    }

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
    // decision, so a viewer never receives one that allows writing. It used to
    // ignore the location's own rights, so somebody who could only read a
    // folder was handed an editing session on the documents in it.
    const canEdit = mode !== 'view' && !isReadonlyShare && accessInfo.canWrite === true;

    const filename = path.basename(abs);
    const ext = toExt(filename);
    const documentType = getDocumentType(ext);
    if (!documentType) {
      // Refused here rather than left for the Document Server to open with the
      // wrong editor: everything used to fall back to 'word', so a drawing was
      // answered "the file content does not match the file extension" — true,
      // unhelpful, and several steps from the setting that caused it.
      throw new ValidationError(
        `ONLYOFFICE has no editor for .${ext} files. Remove it from ONLYOFFICE_FILE_EXTENSIONS, ` +
          'or open it with Collabora instead.'
      );
    }

    const fileUrl = new URL(`/api/onlyoffice/file`, publicConfig.url);
    fileUrl.searchParams.set('path', relativePath);

    const callbackUrl = new URL(`/api/onlyoffice/callback`, publicConfig.url);
    callbackUrl.searchParams.set('path', relativePath);

    // Shared with anyone already in this document, so they edit together rather
    // than in two sessions that overwrite each other. It used to be recomputed
    // from the file's own state on every open, which changed it under the
    // people already editing.
    const key = await resolveKeyForOpen({
      absolutePath: abs,
      relativePath,
      stat,
      documentType,
    });

    // Only an editing session gets one: it is what a save is written through.
    const editorSessionId = canEdit ? await createEditorSession(req, relativePath, key, abs) : null;

    // Backend context for storage requests (signed separately and passed via query)
    let backendToken = null;
    if (onlyoffice.secret) {
      const backendPayload = {
        typ: BACKEND_TOKEN_TYPE,
        absolutePath: abs,
        logicalPath: resolved.relativePath,
        space: resolved.space,
        // The callback trusts this flag instead of re-resolving permissions, so
        // it must say what this session is actually allowed to do.
        canWrite: canEdit,
        // Lets a save find the document again if it was renamed while open; the
        // path above is only what it was called when the editor started.
        sessionId: editorSessionId,
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
          // Expose ONLYOFFICE's own Save action as a force-save when it has
          // been asked for. Closing the document is flushed by the route
          // above, whether or not this is on.
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
      editorSessionId,
      autoSaveIntervalMs: canEdit ? onlyoffice.autoSaveIntervalMs : 0,
    });
  })
);

/**
 * The client says the document is really open, and goes on saying so.
 *
 * Presence starts here rather than when the configuration is handed out: that
 * says nothing about whether the document opened, and a file the editor then
 * refused was still shown to everybody as being edited until it expired.
 */
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
    await getEditorSession(req, sessionId, relativePath);

    const active = onlyofficeActivity.touch({
      absolutePath: resolved.absolutePath,
      sessionId,
      user: describeSessionUser(req),
    });
    res.json({ active });
  })
);

/**
 * The editor was closed. The session ends, so the document stops being reported
 * as open by somebody who has left.
 */
router.post(
  '/onlyoffice/session-end',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    const sessionId = req.body?.sessionId || '';
    if (!relativePath || typeof sessionId !== 'string' || !sessionId) {
      throw new ValidationError('A valid ONLYOFFICE editing session is required.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);
    if (!accessInfo?.canAccess || !accessInfo.canRead) throw new ForbiddenError('Access denied.');
    const session = await getEditorSession(req, sessionId, relativePath);

    // Somebody who was only reading has nothing to flush, and an integration
    // with no Document Server has nowhere to ask. Neither is a reason to refuse
    // the close — the session still has to end, or the document goes on being
    // reported as open by somebody who has left.
    let requestId = null;
    if (onlyoffice.serverUrl && accessInfo.canWrite) {
      requestId =
        pendingForceSavesBySession.get(sessionId) ||
        enqueueForceSave({ sessionId, key: session.key, relativePath, reason: 'close' });
    }

    onlyofficeActivity.close({ absolutePath: resolved.absolutePath, sessionId });
    await editorSessions.remove(sessionId);
    res.json({ ended: true, flushed: Boolean(requestId), requestId });
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
    const session = await getEditorSession(req, sessionId, relativePath);

    const parentPath = path.posix.dirname(relativePath);
    const renamed = await renameEntry({
      context: { user: req.user, guestSession: req.guestSession },
      parentRelative: parentPath === '.' ? '' : parentPath,
      currentName: path.posix.basename(relativePath),
      newName: req.body?.newName,
    });

    if (renamed.changed) {
      // Three records follow the file: the session decides where a save lands,
      // presence decides which row shows as being edited, and the key decides
      // whether the people already in the document stay together.
      const previousRelativePath = session.relativePath;
      await editorSessions.move(sessionId, {
        relativePath: renamed.relativePath,
        absolutePath: renamed.absolutePath,
      });
      onlyofficeActivity.rename({
        from: renamed.previousAbsolutePath,
        to: renamed.absolutePath,
      });
      await documentKeys.renameDocumentKey({
        from: previousRelativePath,
        to: renamed.relativePath,
      });
    }

    res.json({ path: renamed.relativePath, name: renamed.name });
  })
);

const versionHistory = () => require('../services/versions');

const versionKeyFor = (versionId) => `version-${versionId}`;

const editorUserOf = (req) =>
  req.user && req.user.id
    ? { id: String(req.user.id), name: req.user.displayName || req.user.username || 'User' }
    : req.guestSession
      ? { id: `guest_${req.guestSession.id}`, name: 'Guest User' }
      : undefined;

/** A token for `/onlyoffice/file` that serves one content, and never writes. */
const readOnlyFileUrl = (req, relativePath, absolutePath, ttlSeconds) => {
  const backendToken = jwt.sign(
    {
      typ: BACKEND_TOKEN_TYPE,
      absolutePath,
      logicalPath: relativePath,
      canWrite: false,
      sessionId: null,
      userId: req.user?.id ? String(req.user.id) : null,
      guestSessionId: req.guestSession?.id || null,
      shareToken: null,
    },
    onlyoffice.secret,
    { algorithm: 'HS256', expiresIn: ttlSeconds }
  );
  const fileUrl = new URL('/api/onlyoffice/file', publicConfig.url);
  fileUrl.searchParams.set('path', relativePath);
  fileUrl.searchParams.set('backend', backendToken);
  return fileUrl.toString();
};

const requirePublicUrl = () => {
  if (!publicConfig?.url) {
    throw new ValidationError(
      'PUBLIC_URL is required on the server to build absolute URLs for ONLYOFFICE.'
    );
  }
};

/** The key the document is open under now, as the configuration hands it out. */
const currentKeyOf = async (req, relativePath) => {
  const context = { user: req.user, guestSession: req.guestSession };
  const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);
  if (!accessInfo?.canAccess || !accessInfo.canRead || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
  }
  const stat = await fsp.stat(resolved.absolutePath);
  const documentType = getDocumentType(toExt(resolved.absolutePath));
  const key = await resolveKeyForOpen({
    absolutePath: resolved.absolutePath,
    relativePath,
    stat,
    documentType,
  });
  return { key, absolutePath: resolved.absolutePath };
};

/**
 * A version opened on its own, to be read: a viewer, with nothing to save.
 *
 * This is what lets an office document's history be looked at at all — the
 * panel could only offer a text file until now, because nothing could put an
 * earlier .docx in front of anybody.
 */
const versionViewConfig = async (req, relativePath, versionId, uiTheme) => {
  requirePublicUrl();
  const context = { user: req.user, guestSession: req.guestSession };
  const located = await versionHistory().locateVersion(context, relativePath, versionId, {
    download: false,
  });
  const ext = toExt(located.name);
  const documentType = getDocumentType(ext);
  if (!documentType) {
    throw new ValidationError(`ONLYOFFICE has no editor for .${ext} files.`);
  }
  const mayCopy = located.target.rights.download;
  const config = {
    documentType,
    type: 'desktop',
    document: {
      fileType: ext,
      key: versionKeyFor(located.version.id),
      title: located.name,
      url: readOnlyFileUrl(req, relativePath, located.absolutePath, BACKEND_TOKEN_TTL_SECONDS),
      permissions: {
        edit: false,
        comment: false,
        review: false,
        // Printing or downloading a version is taking a copy of it.
        download: mayCopy,
        print: mayCopy,
      },
    },
    // No callback: nothing is saved from a version, and the one the document
    // has would release the key everyone editing it now shares.
    editorConfig: {
      mode: 'view',
      customization: {
        anonymous: { request: false },
        ...(uiTheme ? { uiTheme } : {}),
      },
      lang: onlyoffice.lang || 'en',
      user: editorUserOf(req),
    },
  };
  config.token = jwt.sign(config, onlyoffice.secret, { algorithm: 'HS256' });
  return {
    documentServerUrl: onlyoffice.serverUrl,
    config,
    editorSessionId: null,
    autoSaveIntervalMs: 0,
    version: { id: located.version.id, modifiedAt: located.version.modifiedAt },
  };
};

/**
 * The document's history, as the editor's own history panel reads it.
 *
 * The editor numbers versions from the oldest and expects the current state to
 * be the last of them; the history this application keeps comes newest first
 * and does not count the current state as a version, so the two are reconciled
 * here rather than in the editor.
 */
router.post(
  '/onlyoffice/history',
  asyncHandler(async (req, res) => {
    const relativePath = normalizeRelativePath(req.body?.path || '');
    if (!relativePath) throw new ValidationError('A valid file path is required.');
    const context = { user: req.user, guestSession: req.guestSession };
    const listed = await versionHistory().listVersions(context, relativePath);
    const { key } = await currentKeyOf(req, relativePath);

    const history = [...listed.versions].reverse().map((version, index) => ({
      version: index + 1,
      versionId: version.id,
      key: versionKeyFor(version.id),
      created: version.modifiedAt,
      user: { id: version.author?.id || '', name: version.author?.label || '' },
      label: version.label,
      available: version.available !== false,
    }));
    history.push({
      version: history.length + 1,
      versionId: null,
      key,
      created: listed.file.modifiedAt,
      user: { id: listed.file.author?.id || '', name: listed.file.author?.label || '' },
      label: null,
      available: true,
    });

    res.set('Cache-Control', 'no-store');
    res.json({ currentVersion: history.length, history, canRestore: listed.rights.restore });
  })
);

/** Where one entry of that history is fetched from. */
router.post(
  '/onlyoffice/history-data',
  asyncHandler(async (req, res) => {
    requirePublicUrl();
    const relativePath = normalizeRelativePath(req.body?.path || '');
    if (!relativePath) throw new ValidationError('A valid file path is required.');
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError('A version number is required.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId : '';

    let key;
    let absolutePath;
    let name;
    if (versionId) {
      const located = await versionHistory().locateVersion(context, relativePath, versionId, {
        download: false,
      });
      key = versionKeyFor(located.version.id);
      absolutePath = located.absolutePath;
      name = located.name;
    } else {
      // The current state, from inside the history: the same rights decide.
      await versionHistory().listVersions(context, relativePath);
      ({ key, absolutePath } = await currentKeyOf(req, relativePath));
      name = path.basename(absolutePath);
    }

    const payload = {
      fileType: toExt(name),
      key,
      url: readOnlyFileUrl(req, relativePath, absolutePath, STORAGE_FILE_TOKEN_TTL_SECONDS),
      version,
    };
    payload.token = jwt.sign(payload, onlyoffice.secret, { algorithm: 'HS256' });
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  })
);

/**
 * A file from the storage, handed to the editor.
 *
 * The editor inserts an image, merges a spreadsheet or compares against
 * another document by asking its host for one — it never reaches the storage
 * itself. So the host answers with a URL the Document Server may fetch once,
 * signed, read-only and short-lived, for a file this caller may already read.
 * Nothing is ever written back through it.
 */
router.post(
  '/onlyoffice/storage-file',
  asyncHandler(async (req, res) => {
    requirePublicUrl();
    if (!onlyoffice.secret) {
      throw new ValidationError('ONLYOFFICE_SECRET is required to hand files to the editor.');
    }

    const relativePath = normalizeRelativePath(req.body?.path || '');
    if (!relativePath) {
      throw new ValidationError('A valid file path is required.');
    }
    // What the editor is asking for, carried back untouched in the answer it
    // recognises. Bounded because it is the caller's own string.
    const command = typeof req.body?.c === 'string' ? req.body.c.slice(0, 64) : undefined;

    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);
    if (!accessInfo?.canAccess || !accessInfo.canRead) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
    }

    const stat = await fsp.stat(resolved.absolutePath);
    if (stat.isDirectory()) {
      throw new ValidationError('A file is required.');
    }

    const payload = {
      ...(command === undefined ? {} : { c: command }),
      fileType: toExt(path.basename(resolved.absolutePath)),
      url: readOnlyFileUrl(
        req,
        relativePath,
        resolved.absolutePath,
        STORAGE_FILE_TOKEN_TTL_SECONDS
      ),
    };
    payload.token = jwt.sign(payload, onlyoffice.secret, { algorithm: 'HS256' });

    res.set('Cache-Control', 'no-store');
    res.json(payload);
  })
);

/**
 * "Save as" from inside the editor.
 *
 * ONLYOFFICE does not write anything itself: it converts the document, then
 * hands the integration a URL to fetch the result from. Without a route to
 * receive it the menu entry is hidden, which left Download as the only way out
 * — through the browser, into the person's downloads, not their volume.
 *
 * Deliberately not tied to an editing session: saving a copy is not a change to
 * the original, so a reader may do it too. What it does require is the right to
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
    // at the configured Document Server — the same rule as the save callback.
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

    // Reading the source is what entitles somebody to save a copy of it.
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

    await ensureDir(folder.absolutePath);
    const { name, path: absolute } = await downloadDocumentInto(
      downloadUrl,
      folder.absolutePath,
      desiredName
    );

    const written = await fsp.stat(absolute);
    const savedPath = combineRelativePath(targetFolder, name);
    logger.info(
      { path: savedPath, size: written.size },
      'ONLYOFFICE document saved under a new name'
    );

    res.json({ path: savedPath, name, size: written.size });
  })
);

// How long a token naming one file for the editor is good for: long enough to
// fetch it, short enough that the link is not worth keeping.
const STORAGE_FILE_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Who can be mentioned in a comment.
 *
 * ONLYOFFICE asks for the whole list and filters it in the editor as the
 * comment is typed, so this answers with names and addresses rather than to a
 * query. Only signed-in people get it: a visitor editing through a share link
 * has no business being handed the user directory.
 */
router.get(
  '/onlyoffice/users',
  asyncHandler(async (req, res) => {
    if (!req.user?.id) {
      throw new ForbiddenError('Mentions require a signed-in user.');
    }
    // Required here rather than at the top: the search service reaches into the
    // database, which the route file does not otherwise touch.
    // eslint-disable-next-line global-require
    const { listUsersForMentions } = require('../services/userSearchService');
    res.json({ users: await listUsersForMentions() });
  })
);

/**
 * A comment mentioning somebody was posted.
 *
 * ONLYOFFICE has already written the comment into the document; this is the
 * separate "tell them about it" step, which it leaves entirely to the
 * integration. There is no notification channel to deliver it on, so the
 * mention is recorded and nothing is sent — said plainly, rather than leaving
 * the editor waiting on a handler that silently does nothing.
 */
router.post(
  '/onlyoffice/notify',
  asyncHandler(async (req, res) => {
    if (!req.user?.id) {
      throw new ForbiddenError('Mentions require a signed-in user.');
    }
    const relativePath = normalizeRelativePath(req.body?.path || '');
    if (!relativePath) {
      throw new ValidationError('A valid file path is required.');
    }
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo } = await resolvePathWithAccess(context, relativePath);
    if (!accessInfo?.canAccess || !accessInfo.canRead) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
    }

    const emails = Array.isArray(req.body?.emails)
      ? req.body.emails.filter((email) => typeof email === 'string').slice(0, 50)
      : [];
    logger.info(
      { path: relativePath, by: String(req.user.id), recipients: emails.length },
      'ONLYOFFICE comment mention recorded, no notification channel configured'
    );

    res.json({ delivered: false });
  })
);

/**
 * How an open folder learns that somebody joined or left a document.
 *
 * Held open for up to twenty-five seconds on purpose, rather than asked for
 * every second: presence changes rarely, and a poll that costs nothing while
 * nothing happens is what makes it affordable to show at all.
 */
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

/**
 * Write what the editor is holding, now.
 *
 * Answers as soon as the command is queued: the Document Server writes the
 * document through the ordinary callback, asynchronously. Two requests for the
 * same session are coalesced — a close arriving while an automatic save is
 * still assembling queues one final command behind it rather than a second one
 * beside it.
 */
router.post(
  '/onlyoffice/force-save',
  asyncHandler(async (req, res) => {
    if (!onlyoffice.serverUrl) {
      throw new ValidationError('ONLYOFFICE_URL is not configured on the server.');
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

    const session = await getEditorSession(req, sessionId, relativePath);
    const existingRequestId = pendingForceSavesBySession.get(sessionId);
    const pending = existingRequestId ? pendingForceSaves.get(existingRequestId) : null;
    if (pending) {
      const followUp = reason === 'close' && pending.reason === 'auto';
      if (followUp) pending.followUpReason = 'close';
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
      const backendCtx = readBackendToken(req);

      const body = req.body || {};
      const status = Number(body.status);
      forceSaveRequestId = typeof body.userdata === 'string' ? body.userdata : null;
      const activityPath = backendCtx?.absolutePath;

      // Status 1 reports the users currently connected to the document. It is
      // presence only: this never becomes a filesystem lock, and it expires if
      // the Document Server stops sending callbacks.
      if (status === 1 && activityPath) {
        onlyofficeActivity.updateDocumentServerUsers({
          absolutePath: activityPath,
          users: Array.isArray(body.users) ? body.users : [],
        });
      } else if ((status === 2 || status === 4) && activityPath) {
        onlyofficeActivity.release({ absolutePath: activityPath });
        // The Document Server has let the document go, so its cached copy is
        // now the stale one. Dropping the key is what makes the next open fetch
        // the saved file instead of that copy.
        //
        // The session knows where the document is now; the token only knows
        // where it was when the editor opened, which a rename since then would
        // have made wrong.
        const closing = backendCtx?.sessionId
          ? await editorSessions.get(backendCtx.sessionId)
          : null;
        await documentKeys.releaseDocumentKey(
          closing?.relativePath || backendCtx?.logicalPath || relativePath
        );
      }
      // See ONLYOFFICE callback statuses: 2 - Save, 6 - Force Save
      if ((status === 2 || status === 6) && body.url) {
        // Only the Document Server we handed the document to may be fetched from.
        const downloadUrl = ensureAllowedDownloadUrl(body.url);
        let abs = null;
        if (backendCtx) {
          // The token stands in for a permission check, so it only counts when
          // the session it was issued for was allowed to write.
          if (backendCtx.canWrite !== true) {
            throw new ForbiddenError('This editing session is read-only.');
          }
          await assertShareStillValid(backendCtx);
          // Where the document is now, not where it was called when the editor
          // opened it.
          abs = await resolveSaveTarget(backendCtx);
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
        const explicit =
          status === 2 ||
          Number(body.forcesavetype) === 1 ||
          pendingForceSaves.get(forceSaveRequestId)?.reason === 'close';

        await versions.saveFile(
          abs,
          (temporaryPath) => fetchDocumentInto(downloadUrl, temporaryPath, mode),
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
        finishForceSave(forceSaveRequestId, { saved: status === 6 });
        logger.debug({ path: relativePath, status }, 'ONLYOFFICE file updated');
        // MUST return {error:0} according to ONLYOFFICE spec
        return res.json({ error: 0 });
      }

      // Status 7 is the Document Server saying the force-save failed; status 6
      // without a URL is the same shape. Either way whoever is waiting on that
      // request must be told, or the close hangs until it times out.
      if (status === 6 || status === 7) {
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
