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

export async function requestOnlyOfficeForceSave(path, { signal } = {}) {
  const normalizedPath = normalizePath(path || '');
  if (!normalizedPath) return { queued: false };

  return requestJson('/api/onlyoffice/force-save', {
    method: 'POST',
    body: JSON.stringify({ path: normalizedPath }),
    // Closing the editor must remain possible when Document Server is briefly
    // unavailable; its ordinary delayed callback is the fallback.
    suppressErrorHandler: true,
    signal,
  });
}
