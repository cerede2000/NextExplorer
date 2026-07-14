import { defineStore } from 'pinia';

// Navigation history should feel local to the current browser session, not like
// a user preference. Keep a bounded LRU cache so a long browse session cannot
// accumulate positions indefinitely.
export const FOLDER_SCROLL_POSITION_LIMIT = 100;

export const useFolderScrollStore = defineStore('folderScroll', () => {
  const positions = new Map();
  const permittedRestorePaths = new Set();

  const remember = (key, scrollTop) => {
    if (!key || !Number.isFinite(scrollTop)) return;

    positions.delete(key);
    positions.set(key, Math.max(0, Math.round(scrollTop)));

    while (positions.size > FOLDER_SCROLL_POSITION_LIMIT) {
      positions.delete(positions.keys().next().value);
    }
  };

  const get = (key) => positions.get(key) ?? 0;

  const has = (key) => positions.has(key);

  // Positions are retained in the small LRU cache, but are restored only for
  // an intentional upward navigation within the same mount. This avoids
  // surprising jumps when the user switches volume and later opens a folder
  // that happened to be visited earlier in the session.
  const permitRestore = (path) => {
    if (path) permittedRestorePaths.add(path);
  };

  const preventRestore = (path) => {
    if (path) permittedRestorePaths.delete(path);
  };

  const consumeRestore = (key) => {
    const path = String(key || '').split('::')[0];
    if (!path || !permittedRestorePaths.has(path)) return 0;
    permittedRestorePaths.delete(path);
    return get(key);
  };

  const clear = () => {
    positions.clear();
    permittedRestorePaths.clear();
  };

  return {
    remember,
    get,
    has,
    permitRestore,
    preventRestore,
    consumeRestore,
    clear,
  };
});
