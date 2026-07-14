import { defineStore } from 'pinia';

// Navigation history should feel local to the current browser session, not like
// a user preference. Keep a bounded LRU cache so a long browse session cannot
// accumulate positions indefinitely.
export const FOLDER_SCROLL_POSITION_LIMIT = 100;

export const useFolderScrollStore = defineStore('folderScroll', () => {
  const positions = new Map();

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

  const clear = () => positions.clear();

  return { remember, get, has, clear };
});
