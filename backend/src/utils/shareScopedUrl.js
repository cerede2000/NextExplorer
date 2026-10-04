/**
 * Where a request about a shared file is addressed.
 *
 * The same rule the browser follows (`frontend/src/api/shareScope.js`), for the
 * addresses this server hands out rather than the ones it is asked at: the file
 * an editing server fetches, and the one it reports back to.
 *
 * Those two are not asked by the person reading the share — they are asked by
 * ONLYOFFICE or Collabora, from wherever it runs — and they travel through the
 * same front door. An authentication proxy lets a public link through by path, so
 * a document URL at `/api/onlyoffice/file` is refused for the same reason a
 * preview at `/api/preview` was: it is the whole instance's address. Each of them
 * carries its own signed token, which is what authorises it; the prefix is only
 * where it is reachable.
 */

const SHARE_PATH = /^share\/([^/]+)(?:\/|$)/;

/** The share a logical path belongs to, or '' for anywhere else. */
const shareTokenOfPath = (relativePath) => {
  const match = SHARE_PATH.exec(typeof relativePath === 'string' ? relativePath : '');
  return match ? match[1] : '';
};

/**
 * @param {string} apiPath an `/api/…` address
 * @param {string} relativePath the logical path the request is about
 * @returns {string} the same address, under the share's prefix when there is one
 */
const shareScopedApiPath = (apiPath, relativePath) => {
  const token = shareTokenOfPath(relativePath);
  if (!token) return apiPath;
  return `/api/share/${encodeURIComponent(token)}${apiPath.slice('/api'.length)}`;
};

module.exports = { shareTokenOfPath, shareScopedApiPath };
