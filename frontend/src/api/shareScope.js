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

/**
 * The share the page itself is about, read from the address.
 *
 * Some requests are not about a path at all — the feature flags and the branding
 * are about the page — and they are made before the router has settled, so the
 * address is what there is to ask. Both shapes count: the share's own prefix, and
 * the addresses a link handed out before the move still arrives at.
 */
const LOCATION_SHARE = /^\/(?:browse\/|open\/|editor\/)?share\/([^/?#]+)/;

export const shareTokenOfLocation = (pathname) => {
  const where =
    typeof pathname === 'string'
      ? pathname
      : typeof window !== 'undefined'
        ? window.location.pathname
        : '';
  const match = LOCATION_SHARE.exec(where);
  return match ? match[1] : '';
};

/**
 * The first of several candidates that names a share: a destination, the thing
 * being acted on, whatever the caller has. Written out because an operation on a
 * selection is named by what it touches, not by a single path.
 */
export const shareScopedForAny = (endpoint, ...candidates) => {
  const found = candidates.find((candidate) => shareTokenOfPath(pathOf(candidate)));
  return shareScoped(endpoint, pathOf(found));
};

/** A path, or the path of a thing in a listing. */
const pathOf = (candidate) => {
  if (typeof candidate === 'string') return candidate;
  if (!candidate || typeof candidate !== 'object') return '';
  const base = typeof candidate.path === 'string' ? candidate.path : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  return base && name ? `${base}/${name}` : base || name;
};

/**
 * @param {string} endpoint an `/api/…` address
 * @param {string} [pathname] the address being read, for a test
 * @returns {string} the same endpoint, under the prefix of the share this page is
 *   about when it is about one
 */
export const shareScopedForPage = (endpoint, pathname) => {
  const token = shareTokenOfLocation(pathname);
  if (!token) return endpoint;
  return `/api/share/${encodeURIComponent(token)}${endpoint.slice('/api'.length)}`;
};
