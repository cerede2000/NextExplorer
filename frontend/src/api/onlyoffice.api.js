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
