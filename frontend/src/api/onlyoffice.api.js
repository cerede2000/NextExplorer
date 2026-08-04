// /api/onlyoffice.api.js

import { requestJson, normalizePath } from './http';

/**
 * `theme` is 'light' or 'dark'. It has to travel with the request rather than
 * be applied to the returned config: the Document Server reads its settings
 * from the signed token, so anything set on the object afterwards is dropped.
 */
export async function fetchOnlyOfficeConfig(path, mode = 'edit', { theme } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/config', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, mode, theme }),
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

export async function closeOnlyOfficeSession(path, { sessionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return;
  return requestJson('/api/onlyoffice/session-close', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId }),
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
