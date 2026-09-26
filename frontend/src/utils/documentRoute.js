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
export const documentRoute = (path) => {
  const encoded = encodeFolderPath(path);
  return { path: encoded ? `/open/${encoded}` : '/browse/' };
};
