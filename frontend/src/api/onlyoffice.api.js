// /api/onlyoffice.api.js

import { requestJson, normalizePath } from './http';

export async function fetchOnlyOfficeConfig(path, mode = 'edit') {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/config', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, mode }),
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
