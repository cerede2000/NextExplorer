/**
 * Where a request about a shared file is sent.
 *
 * A visitor with no account asks for the same things as anybody else — a
 * thumbnail, a preview, a download — and those have always been asked at the
 * application's own addresses: `/api/preview`, `/api/thumbnails/…`,
 * `/api/download`. The server checks the share behind each of them, so nothing
 * was open; but a share is also what somebody opens from the far side of an
 * authentication proxy, and such a proxy lets a public link through by path. With
 * a visitor's requests scattered across the API, letting the link through meant
 * opening `/api/download` to the world — for every file in the instance, not just
 * the shared one.
 *
 * So anything about a path inside a share is asked under that share's own prefix,
 * where the same handler answers behind a gate that checks the visitor is the one
 * this share issued a session to. One rule, applied where the address is built,
 * because the path already says which share it belongs to.
 */

const SHARE_PATH = /^share\/([^/]+)(?:\/|$)/;

/** The share a logical path belongs to, or '' for anywhere else. */
export const shareTokenOfPath = (relativePath) => {
  const match = SHARE_PATH.exec(typeof relativePath === 'string' ? relativePath : '');
  return match ? match[1] : '';
};

/**
 * @param {string} endpoint an `/api/…` address
 * @param {string} relativePath the logical path the request is about
 * @returns {string} the same endpoint, under the share's prefix when there is one
 */
export const shareScoped = (endpoint, relativePath) => {
  const token = shareTokenOfPath(relativePath);
  if (!token) return endpoint;
  return `/api/share/${encodeURIComponent(token)}${endpoint.slice('/api'.length)}`;
};
