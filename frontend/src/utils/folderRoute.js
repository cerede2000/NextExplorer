/**
 * Where a folder is, written the way a person would write it.
 *
 * `router.push({ name: 'FolderView', params: { path } })` hands vue-router a
 * single parameter, and vue-router encodes a parameter as one segment: every
 * slash inside it comes back as `%2F`, so `/browse/Stacks/data` reaches the
 * address bar as `/browse/Stacks%2Fdata`. The route itself has never minded —
 * `:path(.+)` matches real slashes — so the only thing between the two shapes
 * is how the push is written. The editor has always written it this way.
 *
 * It is not only about looks. Apache refuses an encoded slash unless
 * `AllowEncodedSlashes` is turned on, so a deep link copied from the address
 * bar can come back as a 404 from somebody's reverse proxy.
 *
 * Addresses already saved with `%2F` keep working: they decode to the same
 * parameter, and the route resolves them to the same folder.
 */

/** Each segment encoded on its own, so the slashes between them survive. */
export const encodeFolderPath = (path) =>
  String(path ?? '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

/**
 * The route for a folder, ready for `router.push`.
 *
 * @param {string} path  Folder path, `share/<token>/…` included.
 * @param {object} [query]  Left out entirely when empty, so no address grows a
 *   bare `?`.
 */
/**
 * A share's own address, which is not under `/browse/`.
 *
 * Everything a visitor with no account touches lives under `/share/<token>/`, so
 * one rule in front of the application can let a public link through without
 * opening the rest of it — which is what every other file manager does, and what
 * ours did not: it dropped its visitors into the prefix of the signed-in
 * application and a proxy had to be told about that one too.
 */
const SHARE = /^share\/([^/]+)(?:\/(.*))?$/;

export const folderRoute = (path, query) => {
  const shared = SHARE.exec(String(path ?? '').replace(/^\/+/, ''));
  const encoded = encodeFolderPath(path);
  const route = {
    path: shared
      ? `/share/${encodeURIComponent(shared[1])}/browse/${encodeFolderPath(shared[2] || '')}`
      : encoded
        ? `/browse/${encoded}`
        : '/browse/',
  };
  return query && Object.keys(query).length > 0 ? { ...route, query } : route;
};
