import { itemKey } from './items';

/**
 * What the client puts on a row itself, and the server knows nothing about: a
 * thumbnail it fetched, and the note that there is none to fetch. Everything
 * else on a row is the server's to say — and to stop saying.
 */
const CLIENT_OWNED = new Set(['thumbnail', 'thumbnailUnavailable']);

/**
 * A new listing, folded into the one on screen.
 *
 * Merge new items into existing list by stable key so that unchanged entries
 * keep their object identity (and any local UI fields such as thumbnails),
 * while still updating metadata and adding/removing items as needed.
 *
 * @param {Array} previousItems  what is on screen
 * @param {Array} items  what the server just answered
 * @returns {Array}
 */
export const mergeListing = (previousItems, items) => {
  if (!Array.isArray(items)) return [];

  const existingByKey = new Map(
    (Array.isArray(previousItems) ? previousItems : [])
      .filter((it) => it && it.name)
      .map((it) => [itemKey(it), it])
  );

  const merged = [];

  for (const incoming of items) {
    if (!incoming || !incoming.name) continue;

    const key = itemKey(incoming);
    const existing = existingByKey.get(key);

    if (existing) {
      // The server's answer is the whole truth about a row, so a field it has
      // stopped sending is taken off rather than left behind. `Object.assign`
      // can only add and overwrite, and each field that went quiet needed its
      // own `delete` to be noticed: the badge for a document no longer being
      // edited, the count on a file whose last version was deleted, the mark
      // on a folder a rule no longer holds. Each of them stayed on screen
      // until the folder was left and come back to. They are all the same
      // defect, so it is answered once, here.
      const prevThumbnail = existing.thumbnail;
      for (const key of Object.keys(existing)) {
        if (!CLIENT_OWNED.has(key) && !Object.hasOwn(incoming, key)) delete existing[key];
      }
      Object.assign(existing, incoming);
      if (!incoming.thumbnail && prevThumbnail) {
        existing.thumbnail = prevThumbnail;
      }
      merged.push(existing);
    } else {
      merged.push(incoming);
    }
  }

  return merged;
};

/**
 * What the folder allows, from a listing's `access` block.
 *
 * @returns {object|null} null for the old answer, a bare array of items
 */
export const folderData = (response, normalizedPath) => {
  if (!(response && typeof response === 'object' && Array.isArray(response.items))) return null;

  const access = response.access && typeof response.access === 'object' ? response.access : null;
  return {
    path: response.path || normalizedPath,
    canRead: access?.canRead ?? true,
    // If the backend doesn't include access metadata, fail open so the UI
    // doesn't hide core actions for older response formats.
    canWrite: access?.canWrite ?? true,
    canUpload: access?.canUpload ?? true,
    canDelete: access?.canDelete ?? true,
    canCreateFolder: access?.canCreateFolder ?? true,
    canCreateFile: access?.canCreateFile ?? true,
    canShare: access?.canShare ?? true,
    canDownload: access?.canDownload ?? true,
    // Whether the files here show their history: through a share, only once
    // its owner turned it on. The server refuses anyway; this decides
    // whether the menu offers what would be refused.
    canSeeVersions: access?.canSeeVersions ?? true,
    isDirectory: response.current?.isDirectory ?? null,
    // Include share metadata if present
    shareInfo: response.shareInfo || null,
  };
};
