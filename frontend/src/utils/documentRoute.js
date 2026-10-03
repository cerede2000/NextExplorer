import { encodeFolderPath } from './folderRoute';

/**
 * Where a document is, as an address of its own.
 *
 * Until this existed, a document had no address at all: opening one filled a
 * panel over the folder it was in, driven by a store, and the browser knew
 * nothing about it. Nothing could be linked to, nothing could be kept as a
 * bookmark, the back button did not close it, and two documents could not be
 * open at once — which is the whole of what somebody replacing Synology Drive
 * or Google Drive asks for (nxzai/NextExplorer#303).
 *
 * Giving it an address is what answers all of that at once, and it is the
 * browser rather than this application that then provides the tabs.
 *
 * Encoded the same way a folder is — each segment on its own, so the slashes
 * between them survive and no address comes back full of `%2F`.
 */
const SHARE = /^share\/([^/]+)(?:\/(.*))?$/;

export const documentRoute = (path) => {
  // Inside a share it goes under the share's own prefix, with everything else a
  // visitor with no account touches: `/share/<token>/open/<file>`.
  const shared = SHARE.exec(String(path ?? '').replace(/^\/+/, ''));
  if (shared) {
    const inner = encodeFolderPath(shared[2] || '');
    return { path: `/share/${encodeURIComponent(shared[1])}/open/${inner}` };
  }
  const encoded = encodeFolderPath(path);
  return { path: encoded ? `/open/${encoded}` : '/browse/' };
};

/**
 * The other direction: a document's address, as the entry it names.
 *
 * `/open/Docs/2026/report.docx` is `{ name: 'report.docx', path: 'Docs/2026' }`,
 * which is the shape every preview plugin is asked about. The document page works
 * this out from its own route parameters; anything that wants to prepare a tab it
 * is *not* on has only the address, and there is no reason for two places to
 * disagree about what it means.
 *
 * Answers null for anything that is not a document address, including `/open/`
 * with nothing after it.
 */
export const documentItemFromAddress = (address) => {
  const plain = String(address || '').split(/[?#]/)[0];
  // Either shape says the same thing: `/open/<path>` and, inside a share,
  // `/share/<token>/open/<path>` — where the file the server is asked for is
  // `share/<token>/<path>`.
  const shared = /^\/share\/([^/]+)\/open\/(.*)$/.exec(plain);
  const match = shared
    ? [plain, `share/${shared[1]}${shared[2] ? `/${shared[2]}` : ''}`]
    : /^\/open\/(.+)$/.exec(plain);
  if (!match) return null;

  const segments = match[1]
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A percent sign that decodes to nothing is still part of a name.
        return segment;
      }
    });
  if (segments.length === 0) return null;

  return { name: segments[segments.length - 1], path: segments.slice(0, -1).join('/') };
};
