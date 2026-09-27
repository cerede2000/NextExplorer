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
 * Make an image the logo, with the rest of the branding in the same request:
 * the server stores both, or neither. Answers the settings, as a patch does.
 */
export async function uploadLogo(file, branding) {
  const form = new FormData();
  if (branding) form.append('branding', JSON.stringify(branding));
  form.append('logo', file);
  return requestJson('/api/settings/upload-logo', { method: 'POST', body: form });
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
