import { ref, watch } from 'vue';

/**
 * A preference remembered per folder, per user.
 *
 * Sorting and view mode both work this way, and they were about to be written
 * twice: the same reconciliation between what the server holds and what this
 * tab has changed, the same guard against a stale response landing after the
 * user has switched, the same cap on how much is kept. One copy, used twice.
 *
 * Saving sends a single folder rather than the whole map — two tabs open on
 * different folders would otherwise overwrite each other with whichever copy
 * was written last.
 */

const MAX_ENTRIES = 100;
const MAX_PATH_LENGTH = 1024;

export function createFolderPreference({
  /** Key under `userSettings` holding the stored map. */
  key,
  /** Key the save endpoint expects for a single folder. */
  saveKey,
  /** Field the endpoint expects the entry under, beside `path`. */
  entryKey,
  /** Turn a stored entry into a valid one, or null. Without `updatedAt`. */
  sanitizeEntry,
  appSettings,
  authStore,
}) {
  const entries = ref({});
  let hasLocalChanges = false;
  let saveChain = Promise.resolve();

  const normalize = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    return Object.fromEntries(
      Object.entries(value)
        .map(([path, entry]) => {
          const sanitized = sanitizeEntry(entry);
          if (!sanitized || typeof path !== 'string' || !path || path.length > MAX_PATH_LENGTH) {
            return null;
          }
          return [
            path,
            {
              ...sanitized,
              updatedAt: Number.isFinite(entry?.updatedAt) ? Math.floor(entry.updatedAt) : 0,
            },
          ];
        })
        .filter(Boolean)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_ENTRIES)
    );
  };

  // What the server holds, reconciled with anything changed here since. A
  // straight overwrite would lose a preference set while the settings were
  // being fetched.
  watch(
    () => appSettings.userSettings?.[key],
    (value) => {
      const saved = normalize(value);
      entries.value = hasLocalChanges ? normalize({ ...saved, ...entries.value }) : saved;
    },
    { immediate: true }
  );

  /** Signing in as someone else must not carry the previous account's choices. */
  const reset = () => {
    hasLocalChanges = false;
    entries.value = normalize(appSettings.userSettings?.[key]);
  };

  watch(() => authStore.currentUser?.id ?? null, reset, { flush: 'sync' });

  const get = (folderPath) => entries.value?.[folderPath] ?? null;

  const set = (folderPath, entry) => {
    const userId = authStore.currentUser?.id ?? null;
    const sanitized = sanitizeEntry(entry);
    if (!folderPath || !sanitized || !appSettings.loaded || !userId) return undefined;

    entries.value = normalize({
      ...entries.value,
      [folderPath]: { ...sanitized, updatedAt: Date.now() },
    });
    hasLocalChanges = true;

    // Chained rather than concurrent: two quick changes would otherwise race,
    // and the server would keep whichever write happened to land second.
    const save = () => {
      if (authStore.currentUser?.id !== userId) return undefined;
      return appSettings.save({
        user: { [saveKey]: { path: folderPath, [entryKey]: sanitized } },
      });
    };

    const result = saveChain.then(save, save);
    saveChain = result.catch(() => undefined);
    return result;
  };

  return { entries, get, set, reset, normalize };
}
