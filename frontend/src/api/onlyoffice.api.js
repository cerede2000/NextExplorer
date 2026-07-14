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

export async function requestOnlyOfficeForceSave(path, { sessionId } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath || !sessionId) return { queued: false };

  return requestJson('/api/onlyoffice/force-save', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath, sessionId }),
    // Closing the editor is intentionally non-blocking. The backend retries a
    // late Document Server update and the regular status-2 callback remains a
    // fallback when a force-save cannot be queued.
    suppressErrorHandler: true,
  });
}
