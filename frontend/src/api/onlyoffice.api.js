// /api/onlyoffice.api.js

import { buildUrl, requestJson, normalizePath } from './http';

/**
 * `theme` is 'light' or 'dark'. It has to travel with the request rather than
 * be applied to the returned config: the Document Server reads its settings
 * from the signed token, so anything set on the object afterwards is dropped.
 */
export async function fetchOnlyOfficeConfig(path, mode = 'edit', { theme, versionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/config', {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      mode,
      theme,
      ...(versionId ? { versionId } : {}),
    }),
  });
}

/** The document's history as the editor shows it: oldest first, the current state last. */
export async function fetchOnlyOfficeHistory(path) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/history', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath }),
  });
}

/**
 * What the editor needs to show one entry of the history, signed for the
 * Document Server: an earlier version by its id, or the current state without one.
 */
export async function fetchOnlyOfficeHistoryData(path, { version, versionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/history-data', {
    method: 'POST',
    body: JSON.stringify({
      path: normalizedPath,
      version,
      ...(versionId ? { versionId } : {}),
    }),
  });
}

export async function requestOnlyOfficeForceSave(path, { sessionId, reason = 'close' } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return { queued: false };

  return requestJson('/api/onlyoffice/force-save', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId, reason }),
    // Keep the short close request eligible to finish while the preview is
    // being destroyed. The backend owns the longer Document Server workflow.
    keepalive: reason === 'close',
    suppressErrorHandler: true,
  });
}

/**
 * Save the open document under a new name or format.
 *
 * ONLYOFFICE has already converted it and gives us a URL to fetch the result
 * from; the backend is what pulls it in and writes it beside the original.
 */
export async function saveOnlyOfficeDocumentAs(path, { url, title } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !url || !title) throw new Error('Path, url and title are required.');

  return requestJson('/api/onlyoffice/save-as', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, url, title }),
  });
}

/**
 * Rename the open document from the editor's title bar.
 *
 * Goes through the ONLYOFFICE route rather than the generic rename so the
 * editing session follows the file; a save arriving afterwards would otherwise
 * recreate the old name.
 */
export async function renameOnlyOfficeDocument(path, { sessionId, newName } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId || !newName) {
    throw new Error('Path, session and new name are required.');
  }

  return requestJson('/api/onlyoffice/rename', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId, newName }),
  });
}

/**
 * Turn a file the user picked into something the Document Server can fetch.
 *
 * The editor inserts images and opens comparison documents by downloading a
 * URL itself, so the backend answers with a signed, short-lived one. `c` comes
 * from the event and is part of what the signature covers, so it has to be
 * passed through rather than added afterwards.
 */
export async function fetchOnlyOfficeStorageFile(path, { c } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/storage-file', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, c }),
  });
}

/**
 * The people the editor offers when a comment starts with @.
 *
 * ONLYOFFICE takes the whole list and filters it itself as the name is typed,
 * so there is no search term to pass.
 */
export async function fetchOnlyOfficeMentionUsers() {
  return requestJson('/api/onlyoffice/users', { method: 'GET', suppressErrorHandler: true });
}

/**
 * Report a comment that mentions someone.
 *
 * The comment is already in the document; this is the separate notification
 * step, which ONLYOFFICE leaves to the integration.
 */
export async function notifyOnlyOfficeMention(path, { emails, actionLink, comment } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/notify', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, emails, actionLink, comment }),
    suppressErrorHandler: true,
  });
}

export async function heartbeatOnlyOfficeSession(path, { sessionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return { active: false };
  return requestJson('/api/onlyoffice/session-heartbeat', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId }),
    suppressErrorHandler: true,
  });
}

/**
 * The editing session is over: the server flushes what the editor holds and
 * lets the session go, in that order.
 *
 * `beacon` is for a page that is being unloaded. A tab being closed gives one
 * synchronous moment, and an ordinary request started in it is cancelled along
 * with everything else — `sendBeacon` hands the request to the browser, which
 * sends it after the page is gone, with the same cookies. `keepalive` is the
 * same idea through `fetch`, and is what answers when a browser has no
 * `sendBeacon`; it is also what makes the reply readable, which is why the
 * panel — which has time — uses it.
 */
export async function endOnlyOfficeSession(path, { sessionId, beacon = false } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return null;
  const body = JSON.stringify({ path: normalizedPath, sessionId });

  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const handedOver = navigator.sendBeacon(
        buildUrl('/api/onlyoffice/session-end'),
        // Typed, because the server reads JSON bodies and nothing else: a
        // beacon sent as text/plain arrives with an empty body.
        new Blob([body], { type: 'application/json' })
      );
      if (handedOver) return null;
    } catch (_) {
      // A browser that refused the beacon still has the request below.
    }
  }

  return requestJson('/api/onlyoffice/session-end', {
    method: 'POST',
    body,
    keepalive: true,
    suppressErrorHandler: true,
  });
}

export async function waitForOnlyOfficeActivityVersion(since, options = {}) {
  const query = Number.isInteger(since) ? `?since=${since}` : '';
  return requestJson(`/api/onlyoffice/activity-version${query}`, {
    method: 'GET',
    signal: options.signal,
    retryNetworkErrors: false,
    suppressErrorHandler: true,
  });
}
