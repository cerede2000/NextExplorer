// /api/onlyoffice.api.js

import { buildUrl, requestJson, normalizePath } from './http';

export async function fetchOnlyOfficeConfig(path, mode = 'edit') {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) throw new Error('Path is required.');

  return requestJson('/api/onlyoffice/config', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, mode }),
  });
}

/**
 * The document is really open, and goes on being open.
 *
 * Sent once ONLYOFFICE reports the document ready, then on a timer: the
 * configuration alone says nothing about whether the document opened, so
 * presence starts here rather than there.
 */
export async function heartbeatOnlyOfficeSession(path, { sessionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return { active: false };

  return requestJson('/api/onlyoffice/session-heartbeat', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId }),
  });
}

/**
 * The editing session is over.
 *
 * `beacon` is for a page being unloaded. A tab being closed gives one
 * synchronous moment, and an ordinary request started in it is cancelled along
 * with everything else — `sendBeacon` hands the request to the browser, which
 * sends it after the page is gone, with the same cookies. `keepalive` is the
 * same idea through `fetch`, and is what answers when a browser has no
 * `sendBeacon`; it is also what makes the reply readable, which is why the
 * preview — which has time — uses it.
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
  });
}

/**
 * Rename the open document from the editor's title bar.
 *
 * The session id goes with it so the server can keep that session pointing at
 * the file; a save arriving afterwards would otherwise recreate the old name.
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
 * Ask the server to write what the editor is holding, now.
 *
 * Answers as soon as the command is queued; the document is written through the
 * ordinary callback. `close` is the flush on the way out, `auto` the periodic
 * one — the server coalesces the two rather than queueing them side by side.
 */
export async function requestOnlyOfficeForceSave(path, { sessionId, reason = 'close' } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return { queued: false };

  return requestJson('/api/onlyoffice/force-save', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId, reason }),
  });
}

/**
 * Wait until somebody joins or leaves a document.
 *
 * Held open by the server for up to twenty-five seconds, so an open folder can
 * keep its marks current without asking every second.
 */
export async function waitForOnlyOfficeActivityVersion(since, options = {}) {
  const query = Number.isInteger(since) ? `?since=${since}` : '';
  return requestJson(`/api/onlyoffice/activity-version${query}`, {
    method: 'GET',
    ...options,
  });
}
