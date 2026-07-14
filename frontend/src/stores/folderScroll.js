import { defineStore } from 'pinia';

// Navigation history should feel local to the current browser session, not like
// a user preference. Keep a bounded LRU cache so a long browse session cannot
// accumulate positions indefinitely.
export const FOLDER_SCROLL_POSITION_LIMIT = 100;
const EXPLICIT_RESTORE_TTL_MS = 30000;

export const useFolderScrollStore = defineStore('folderScroll', () => {
  const positions = new Map();
  const permittedRestorePaths = new Set();
  const explicitRestoreDeadlines = new Map();

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

  const permitRestore = (path) => {
    if (path) permittedRestorePaths.add(path);
  };

  // Some routes, such as the text editor, leave BrowserLayout completely.
  // Their return path is known by the departing view, but not by the generic
  // router rule. Keep that one explicit return through the global guard, and
  // expire it in case the navigation is cancelled before FolderView mounts.
  const permitExplicitRestore = (path) => {
    if (!path) return;
    permittedRestorePaths.add(path);
    explicitRestoreDeadlines.set(path, Date.now() + EXPLICIT_RESTORE_TTL_MS);
  };

  const hasActiveExplicitRestore = (path) => {
    const deadline = explicitRestoreDeadlines.get(path);
    if (!deadline) return false;
    if (deadline > Date.now()) return true;
    explicitRestoreDeadlines.delete(path);
    permittedRestorePaths.delete(path);
    return false;
  };

  const preventRestore = (path) => {
    if (!path || hasActiveExplicitRestore(path)) return;
    permittedRestorePaths.delete(path);
  };

  const consumeRestore = (key) => {
    const path = String(key || '').split('::')[0];
    if (!path || !permittedRestorePaths.has(path)) return 0;
    if (explicitRestoreDeadlines.has(path) && !hasActiveExplicitRestore(path)) return 0;
    permittedRestorePaths.delete(path);
    explicitRestoreDeadlines.delete(path);
    return get(key);
  };

  const clear = () => {
    positions.clear();
    permittedRestorePaths.clear();
    explicitRestoreDeadlines.clear();
  };

  return {
    remember,
    get,
    has,
    permitRestore,
    permitExplicitRestore,
    preventRestore,
    consumeRestore,
    clear,
  };
});
