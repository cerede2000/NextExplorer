import { encodeFolderPath } from './folderRoute';

/**
 * Where a file opened in the text editor lives, as an address.
 *
 * Written here because it was written in two places — the listing's double click
 * and the composable three other gestures ask — and neither knew about a share.
 * Inside one, the address goes under the share's own prefix with everything else a
 * visitor with no account touches: `/share/<token>/editor/<file>`.
 */
const SHARE = /^share\/([^/]+)(?:\/(.*))?$/;

export const editorRoute = (path) => {
  const whole = String(path ?? '').replace(/^\/+/, '');
  const shared = SHARE.exec(whole);
  if (shared) {
    const inner = encodeFolderPath(shared[2] || '');
    return { path: `/share/${encodeURIComponent(shared[1])}/editor/${inner}` };
  }
  return { path: `/editor/${encodeFolderPath(whole)}` };
};
