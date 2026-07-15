import { requestJson, normalizePath, encodePath } from './http';

/**
 * Create a new share
 */
async function createShare({
  sourcePath,
  accessMode = 'readonly',
  sharingType = 'anyone',
  password = null,
  userIds = [],
  expiresAt = null,
  label = null,
}) {
  const normalizedPath = normalizePath(sourcePath);

  return requestJson('/api/shares', {
    method: 'POST',
    body: JSON.stringify({
      sourcePath: normalizedPath,
      accessMode,
      sharingType,
      password,
      userIds,
      expiresAt,
      label,
    }),
  });
}

/**
 * Get all shares created by current user
 */
async function getMyShares() {
  return requestJson('/api/shares', { method: 'GET' });
}

/**
 * Get shares shared with current user
 */
async function getSharedWithMe() {
  return requestJson('/api/shares/shared-with-me', { method: 'GET' });
}

/**
 * Get share details by ID
 */
async function getShareById(shareId) {
  return requestJson(`/api/shares/${shareId}`, { method: 'GET' });
}

/**
 * Update an existing share
 */
async function updateShare(shareId, updates) {
  return requestJson(`/api/shares/${shareId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

/**
 * Delete a share
 */
async function deleteShare(shareId) {
  return requestJson(`/api/shares/${shareId}`, {
    method: 'DELETE',
  });
}

/**
 * Get public share info (no auth required)
 */
async function getShareInfo(shareToken) {
  return requestJson(`/api/share/${shareToken}/info`, { method: 'GET' });
}

/**
 * Verify password for a password-protected share
 */
async function verifySharePassword(shareToken, password) {
  return requestJson(`/api/share/${shareToken}/verify`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

/**
 * Access a share (creates guest session if needed)
 */
async function accessShare(shareToken) {
  return requestJson(`/api/share/${shareToken}/access`, { method: 'GET' });
}

/**
 * Browse share contents
 */
async function browseShare(shareToken, innerPath = '', options = {}) {
  const normalizedInnerPath = normalizePath(innerPath);
  const encodedPath = encodePath(normalizedInnerPath);
  const endpoint = encodedPath
    ? `/api/share/${shareToken}/browse/${encodedPath}`
    : `/api/share/${shareToken}/browse/`;

  return requestJson(endpoint, { method: 'GET', signal: options.signal });
}

/**
 * Store guest session ID in sessionStorage
 */
function setGuestSession(sessionId, shareToken = '') {
  if (sessionId) {
    sessionStorage.setItem('guestSessionId', sessionId);
    if (shareToken) {
      sessionStorage.setItem('guestSessionShareToken', shareToken);
    }
  } else {
    sessionStorage.removeItem('guestSessionId');
    sessionStorage.removeItem('guestSessionShareToken');
  }
}

/**
 * Get guest session ID from sessionStorage
 */
function getGuestSession() {
  return sessionStorage.getItem('guestSessionId');
}

function getGuestSessionShareToken() {
  return sessionStorage.getItem('guestSessionShareToken');
}

/**
 * Clear guest session
 */
function clearGuestSession() {
  sessionStorage.removeItem('guestSessionId');
  sessionStorage.removeItem('guestSessionShareToken');
}

/**
 * Generate share URL for a token
 */
function getShareUrl(shareToken) {
  const baseUrl = window.location.origin;
  return `${baseUrl}/share/${shareToken}`;
}

const DIRECT_SHARE_FILE_MODES = [
  { value: 'auto', labelKey: 'share.directLinkModes.auto', fallback: 'Auto' },
  { value: 'inline', labelKey: 'share.directLinkModes.inline', fallback: 'View' },
  { value: 'raw', labelKey: 'share.directLinkModes.raw', fallback: 'Raw' },
  { value: 'editor', labelKey: 'share.directLinkModes.editor', fallback: 'Editor' },
  { value: 'download', labelKey: 'share.directLinkModes.download', fallback: 'Download' },
];

function normalizeDirectShareFileMode(mode) {
  const value = typeof mode === 'string' ? mode.toLowerCase() : 'auto';
  return DIRECT_SHARE_FILE_MODES.some((item) => item.value === value) ? value : 'auto';
}

/**
 * Generate direct shared file URL for a token and optional inner path
 */
function getDirectShareFileUrl(shareToken, innerPath = '', mode = 'auto') {
  const baseUrl = window.location.origin;
  const encodedToken = encodeURIComponent(shareToken);
  const normalizedInnerPath = normalizePath(innerPath);
  const encodedInnerPath = encodePath(normalizedInnerPath);
  const url = encodedInnerPath
    ? `${baseUrl}/api/share/${encodedToken}/file/${encodedInnerPath}`
    : `${baseUrl}/api/share/${encodedToken}/file`;
  const normalizedMode = normalizeDirectShareFileMode(mode);
  if (normalizedMode === 'editor') {
    return getDirectShareEditorUrl(shareToken, normalizedInnerPath);
  }
  return normalizedMode === 'auto' ? url : `${url}?mode=${encodeURIComponent(normalizedMode)}`;
}

function getDirectShareEditorUrl(shareToken, innerPath = '') {
  const baseUrl = window.location.origin;
  const encodedToken = encodeURIComponent(shareToken);
  const encodedInnerPath = encodePath(normalizePath(innerPath));
  return encodedInnerPath
    ? `${baseUrl}/editor/share/${encodedToken}/${encodedInnerPath}`
    : `${baseUrl}/editor/share/${encodedToken}`;
}

const writeToClipboard = async (value) => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  // Fallback for older browsers
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const success = document.execCommand('copy');
  document.body.removeChild(textarea);
  return success;
};

/**
 * Copy share URL to clipboard
 */
async function copyShareUrl(shareToken) {
  const url = getShareUrl(shareToken);
  return writeToClipboard(url);
}

/**
 * Copy direct shared file URL to clipboard
 */
async function copyDirectShareFileUrl(shareToken, innerPath = '', mode = 'auto') {
  const url = getDirectShareFileUrl(shareToken, innerPath, mode);
  return writeToClipboard(url);
}

export {
  createShare,
  getMyShares,
  getSharedWithMe,
  getShareById,
  updateShare,
  deleteShare,
  getShareInfo,
  verifySharePassword,
  accessShare,
  browseShare,
  setGuestSession,
  getGuestSession,
  getGuestSessionShareToken,
  clearGuestSession,
  getShareUrl,
  DIRECT_SHARE_FILE_MODES,
  getDirectShareFileUrl,
  getDirectShareEditorUrl,
  copyShareUrl,
  copyDirectShareFileUrl,
};
