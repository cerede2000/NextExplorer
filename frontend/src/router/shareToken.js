/**
 * Which share an address is about.
 *
 * The one question the guard has to get right before it asks anything else: it
 * decides *which* share `resolveShareAccess` checks, so reading the wrong token
 * out of an address would check the wrong share — and a visitor carrying a valid
 * session for one share would be let into another.
 *
 * Two shapes answer it. A share's own addresses name the token as a parameter:
 * `/share/<token>/browse/…`, `/share/<token>/open/…`, `/share/<token>/editor/…`
 * and `/share/<token>/compare`, which is where everything a visitor with no
 * account touches now lives. The shape before that put the share inside the
 * folder path — `/browse/share/<token>` — and links already handed out still
 * arrive that way.
 *
 * Kept beside the router rather than inside its guard so that it can be asked
 * directly: what decides who sees somebody's files should not be verifiable only
 * by navigating.
 */

/** A wildcard parameter, which vue-router hands over as an array of segments. */
const segmentsOf = (value) =>
  Array.isArray(value) ? value.filter(Boolean).join('/') : String(value || '');

/** The routes that carry their share in a parameter of their own. */
const NAMED = new Set(['ShareBrowse', 'ShareDocument', 'SharedEditor', 'ShareCompare']);

export const shareTokenOf = (route) => {
  if (NAMED.has(route?.name)) {
    return typeof route?.params?.token === 'string' ? route.params.token : '';
  }
  // The older shape: the share is the first two segments of the folder path.
  const path = segmentsOf(route?.params?.path);
  if (!path.startsWith('share/')) return '';
  return path.split('/')[1] || '';
};
