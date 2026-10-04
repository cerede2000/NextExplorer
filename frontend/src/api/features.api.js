// /api/features.api.js

import { requestJson } from './http';
import { shareScopedForPage } from './shareScope';

/**
 * Asked under the share's prefix when the page is a share, because that is the
 * only prefix a visitor behind an authentication proxy reaches — and falling back
 * to the defaults is not good enough here: whether this installation has an office
 * editor at all is one of these flags, so a share holding a spreadsheet offered no
 * way to open it.
 *
 * Still asked quietly. The application answers for its own failure either way, and
 * a reader who cannot be told anything useful should not be told anything at all.
 */
export async function fetchFeatures() {
  return requestJson(shareScopedForPage('/api/features'), {
    method: 'GET',
    suppressErrorHandler: true,
  });
}

/**
 * Which optional tools this installation has — administrators only, for the
 * About page. The same report the server writes to its log at start.
 */
export async function fetchCapabilities() {
  return requestJson('/api/capabilities', { method: 'GET' });
}
