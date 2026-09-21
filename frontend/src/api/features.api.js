// /api/features.api.js

import { requestJson } from './http';

export async function fetchFeatures() {
  return requestJson('/api/features', { method: 'GET' });
}

/**
 * Which optional tools this installation has — administrators only, for the
 * About page. The same report the server writes to its log at start.
 */
export async function fetchCapabilities() {
  return requestJson('/api/capabilities', { method: 'GET' });
}
