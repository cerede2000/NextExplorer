// /api/features.api.js

import { requestJson } from './http';

/**
 * Asked quietly: what this installation offers is read before anybody has done
 * anything, and the application answers for its own failure — it falls back to the
 * defaults and carries on. A reader who cannot be told anything useful should not
 * be told anything at all, and a visitor opening a share behind an authentication
 * proxy that refuses this one was handed a red banner for each of them.
 */
export async function fetchFeatures() {
  return requestJson('/api/features', { method: 'GET', suppressErrorHandler: true });
}

/**
 * Which optional tools this installation has — administrators only, for the
 * About page. The same report the server writes to its log at start.
 */
export async function fetchCapabilities() {
  return requestJson('/api/capabilities', { method: 'GET' });
}
