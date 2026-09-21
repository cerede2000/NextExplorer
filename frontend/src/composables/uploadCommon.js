/**
 * What the upload dialog and the upload engine both need, kept apart from the
 * engine so that neither the dialog nor the settings screen pulls Uppy into
 * the page that loads first.
 */

// Per-origin remembered auto-fallback chunk size (localStorage is scoped to the
// origin, so the public URL and a LAN IP each keep their own value). Exported so
// the settings screen can reset it (revert this origin to direct uploads).
export const UPLOAD_FALLBACK_STORAGE_KEY = 'nextExplorer_upload_fallback_chunk_mib';

export const getUploadFallbackMiB = () => {
  try {
    const value = Number(localStorage.getItem(UPLOAD_FALLBACK_STORAGE_KEY));
    return Number.isFinite(value) && value >= 1 ? value : null;
  } catch (_) {
    return null;
  }
};

export const writeUploadFallbackMiB = (mib) => {
  try {
    localStorage.setItem(UPLOAD_FALLBACK_STORAGE_KEY, String(mib));
  } catch (_) {
    /* noop */
  }
};

export const resetUploadFallback = () => {
  try {
    localStorage.removeItem(UPLOAD_FALLBACK_STORAGE_KEY);
  } catch (_) {
    /* noop */
  }
};

export const createUploadBatchId = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * An error toast that says a thing once, not once per file of a folder.
 *
 * @param {{ addNotification: Function }} notificationsStore
 */
export const createErrorNotifier = (notificationsStore) => {
  let lastNotifyAt = 0;
  let lastNotifyKey = '';

  return (heading, extra = {}) => {
    const now = Date.now();
    const { dedupeKey, dedupeMs = 10000, ...notificationExtra } = extra;
    const key = dedupeKey || heading;
    if (key === lastNotifyKey && now - lastNotifyAt < dedupeMs) return;
    lastNotifyAt = now;
    lastNotifyKey = key;
    notificationsStore.addNotification({ type: 'error', heading, ...notificationExtra });
  };
};
