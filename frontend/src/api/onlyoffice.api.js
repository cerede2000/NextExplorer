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
