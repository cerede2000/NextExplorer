import { itemKey } from './items';

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
      // Preserve any locally-added thumbnail if the backend
      // does not send one, but refresh all other metadata.
      const prevThumbnail = existing.thumbnail;
      Object.assign(existing, incoming);
      // A missing property is meaningful for transient state such as the
      // OnlyOffice activity badge: remove the old value immediately when
      // the server reports that the document is no longer active.
      if (!Object.hasOwn(incoming, 'onlyofficeActivity')) {
        delete existing.onlyofficeActivity;
      }
      // The same, for the mark that says a file has earlier versions:
      // delete the last one and the server stops sending the count, which
      // `Object.assign` would otherwise have left on the row until the
      // folder was left and come back to.
      if (!Object.hasOwn(incoming, 'versions')) {
        delete existing.versions;
      }
      if (!incoming.thumbnail && prevThumbnail) {
        existing.thumbnail = prevThumbnail;
      }
      // `supportsThumbnail` can be toggled by system settings; if the backend does not
      // include it for an item, treat it as false so we don't keep stale truthy values.
      existing.supportsThumbnail = Boolean(incoming.supportsThumbnail);
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
