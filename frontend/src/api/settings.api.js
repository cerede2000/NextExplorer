// /api/settings.api.js

import { requestJson } from './http';

export async function getBranding() {
  return requestJson('/api/branding', { method: 'GET' });
}

export async function getSettings() {
  return requestJson('/api/settings', { method: 'GET' });
}

export async function patchSettings(partial) {
  return requestJson('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(partial || {}),
  });
}

/**
 * What each path of an access rule names on the disk, so the rule editor can
 * warn about one that names nothing and offer the folder probably meant.
 * Answers `{ paths: [{ path, status, suggestion }] }`, in the order sent.
 */
export async function checkAccessRulePaths(paths) {
  return requestJson('/api/settings/access/check-paths', {
    method: 'POST',
    body: JSON.stringify({ paths: Array.isArray(paths) ? paths : [] }),
  });
}
