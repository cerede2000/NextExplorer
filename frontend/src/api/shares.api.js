import { forgetGuestSession, guestSessionShareToken, rememberGuestSession } from './guestSession';
import { requestJson, normalizePath, encodePath } from './http';

/**
 * Create a new share
 */
async function createShare({
  sourcePath,
  accessMode = 'readonly',
  allowDelete = true,
  allowCreateFolder = true,
  allowCreateFile = true,
  allowUpload = true,
  allowDownload = true,
  sharingType = 'anyone',
  password = null,
  userIds = [],
  expiresAt = null,
  label = null,
  // Left out of the body when not given, so the server's default for the kind
  // of share applies: shown for named people, hidden for a link for anyone.
  versionsVisible,
  versionsDownload,
}) {
  const normalizedPath = normalizePath(sourcePath);

  return requestJson('/api/shares', {
    method: 'POST',
    body: JSON.stringify({
      sourcePath: normalizedPath,
      accessMode,
      allowDelete,
      allowCreateFolder,
      allowCreateFile,
      allowUpload,
      allowDownload,
      sharingType,
      password,
      userIds,
      expiresAt,
      label,
      versionsVisible,
      versionsDownload,
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

  return requestJson(endpoint, {
    method: 'GET',
    signal: options.signal,
    // Short-lived state is in a listing here too — see `browse`, which comes
    // through for anything inside a share.
    cache: 'no-store',
  });
}

/**
 * Keep the session a share handed this tab, or drop it.
 *
 * The value itself lives in `guestSession.js`, where it is a ref the rest of the
 * application can watch — see the note there for why reading the store on demand
 * was not enough.
 */
function setGuestSession(sessionId, shareToken = '') {
  if (sessionId) rememberGuestSession(sessionId, shareToken);
  else forgetGuestSession();
}

function getGuestSessionShareToken() {
  return guestSessionShareToken.value;
}

/**
 * Where a link that leaves this session has to point.
 *
 * Two origins are in play and they are not interchangeable. The one in the address
 * bar is wherever this browser happens to have reached the application — which on a
 * local network is an address only that network can resolve. The other is the name
 * the instance is published under, which the server knows as `PUBLIC_URL` and tells
 * every client in `/api/features`.
 *
 * A link somebody is going to paste into a message must carry the published name: a
 * share link built from the address bar of an administrator sitting on the local
 * network reads `http://192.168.1.250:3017/...`, which is a link nobody outside that
 * network can open. The share dialog made that mistake while *showing* the right
 * address, because the server builds the one on screen and the browser rebuilt the
 * one it copied — so you copied something you had not read.
 *
 * An address this session opens for itself is the opposite: it must stay on the
 * origin this browser is already on, or a window opened on the local network would
 * be sent to a name that network may not resolve.
 */
let publishedOrigin = '';

const setPublishedOrigin = (origin) => {
  publishedOrigin = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
};

/** For a link to hand out. */
const originToHandOut = () => publishedOrigin || window.location.origin;

/**
 * Generate share URL for a token
 */
function getShareUrl(shareToken) {
  return `${originToHandOut()}/share/${shareToken}`;
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
function buildDirectShareFileUrl(baseUrl, shareToken, innerPath = '', mode = 'auto') {
  const encodedToken = encodeURIComponent(shareToken);
  const normalizedInnerPath = normalizePath(innerPath);
  const encodedInnerPath = encodePath(normalizedInnerPath);
  const url = encodedInnerPath
    ? `${baseUrl}/api/share/${encodedToken}/file/${encodedInnerPath}`
    : `${baseUrl}/api/share/${encodedToken}`;
  const normalizedMode = normalizeDirectShareFileMode(mode);
  if (normalizedMode === 'editor') {
    return buildDirectShareEditorUrl(baseUrl, shareToken, normalizedInnerPath);
  }
  return normalizedMode === 'auto' ? url : `${url}?mode=${encodeURIComponent(normalizedMode)}`;
}

function buildDirectShareEditorUrl(baseUrl, shareToken, innerPath = '') {
  const encodedToken = encodeURIComponent(shareToken);
  const encodedInnerPath = encodePath(normalizePath(innerPath));
  return encodedInnerPath
    ? `${baseUrl}/editor/share/${encodedToken}/${encodedInnerPath}`
    : `${baseUrl}/editor/share/${encodedToken}`;
}

/** What this session opens for itself: the origin it is already on. */
function getDirectShareFileUrl(shareToken, innerPath = '', mode = 'auto') {
  return buildDirectShareFileUrl(window.location.origin, shareToken, innerPath, mode);
}

/** What somebody is going to paste somewhere else: the name the instance is published under. */
function getShareableDirectFileUrl(shareToken, innerPath = '', mode = 'auto') {
  return buildDirectShareFileUrl(originToHandOut(), shareToken, innerPath, mode);
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
  return writeToClipboard(getShareableDirectFileUrl(shareToken, innerPath, mode));
}

export {
  createShare,
  getMyShares,
  getSharedWithMe,
  updateShare,
  deleteShare,
  getShareInfo,
  verifySharePassword,
  accessShare,
  browseShare,
  setGuestSession,
  getGuestSessionShareToken,
  DIRECT_SHARE_FILE_MODES,
  setPublishedOrigin,
  getDirectShareFileUrl,
  getShareableDirectFileUrl,
  copyShareUrl,
  copyDirectShareFileUrl,
};
