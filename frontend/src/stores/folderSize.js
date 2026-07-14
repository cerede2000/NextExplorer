import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getFolderSizesBatch, normalizePath, refreshFolderSize } from '@/api';
import { useFeaturesStore } from '@/stores/features';

const REFRESH_THROTTLE_MS = 2500;

const normalizeEntry = (raw = {}) => ({
  path: normalizePath(raw.path || ''),
  sizeBytes: Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
  entryCount: Number.isFinite(raw.entryCount) ? raw.entryCount : null,
  canEnter: Boolean(raw.canEnter),
  indexed: Boolean(raw.indexed),
  dirty: Boolean(raw.dirty),
  lastUpdated: raw.lastUpdated || null,
});

const samePaths = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * Store for pre-computed folder sizes. Mirrors the volumeUsage store's shape
 * (reactive map keyed by normalized path, throttle + refreshPromise guard,
 * scheduleRefresh) but tracks the set of folder paths currently visible and
 * populates them in a single batch request.
 */
export const useFolderSizeStore = defineStore('folderSize', () => {
  const sizes = ref({});
  const isLoading = ref(false);

  let refreshPromise = null;
  let refreshTimer = null;
  let lastRefreshAt = 0;
  let trackedPaths = [];
  let queuedRefresh = false;
  let inFlightTargets = null;

  const setPaths = (paths = []) => {
    const seen = new Set();
    trackedPaths = [];
    for (const p of paths) {
      const key = normalizePath(p || '');
      if (key && !seen.has(key)) {
        seen.add(key);
        trackedPaths.push(key);
      }
    }
  };

  const sizeFor = (path) => {
    const key = normalizePath(path || '');
    return key ? sizes.value[key] || null : null;
  };

  // Fetch the given paths in one batch and merge the results into `sizes`.
  const fetchSizes = async (targets) => {
    try {
      const response = await getFolderSizesBatch(targets);
      const results = Array.isArray(response?.results) ? response.results : [];
      const next = { ...sizes.value };
      for (const raw of results) {
        const entry = normalizeEntry(raw);
        if (entry.path) next[entry.path] = entry;
      }
      sizes.value = next;
      lastRefreshAt = Date.now();
    } catch (_) {
      // Non-fatal: leave any previously known sizes in place.
    }
  };

  const refresh = async ({ force = false, paths } = {}) => {
    const featuresStore = useFeaturesStore();
    await featuresStore.ensureLoaded();

    if (!featuresStore.folderSizeEnabled) {
      sizes.value = {};
      return;
    }

    if (Array.isArray(paths)) {
      setPaths(paths);
    }

    if (!trackedPaths.length) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastRefreshAt < REFRESH_THROTTLE_MS) {
      return;
    }

    // A batch is already in flight. Don't silently drop this request: if the
    // tracked paths have changed since that batch started (e.g. the user
    // navigated into another folder while the previous batch was still loading),
    // queue exactly one follow-up that re-runs with the latest paths once the
    // current batch settles. Identical concurrent calls are genuine duplicates,
    // so we just share the in-flight promise.
    if (refreshPromise) {
      if (!samePaths(trackedPaths, inFlightTargets)) {
        queuedRefresh = true;
      }
      return refreshPromise;
    }

    isLoading.value = true;
    refreshPromise = (async () => {
      try {
        do {
          queuedRefresh = false;
          inFlightTargets = [...trackedPaths];
          await fetchSizes(inFlightTargets);
        } while (queuedRefresh);
      } finally {
        refreshPromise = null;
        inFlightTargets = null;
        isLoading.value = false;
      }
    })();

    return refreshPromise;
  };

  /**
   * Track and fetch sizes for the folders currently in view. Forced so a fresh
   * navigation always populates, while the refreshPromise guard still prevents
   * an overlapping duplicate request.
   */
  const ensureSizes = async (paths = []) => {
    setPaths(paths);
    if (!trackedPaths.length) return;
    await refresh({ force: true });
  };

  const scheduleRefresh = ({ delayMs = 500, force = true } = {}) => {
    if (refreshTimer) {
      globalThis.clearTimeout(refreshTimer);
    }
    refreshTimer = globalThis.setTimeout(() => {
      refreshTimer = null;
      refresh({ force }).catch(() => {});
    }, delayMs);
  };

  // Explicit repair for a folder changed outside NextExplorer. The backend
  // indexes only that subtree, then this updates the visible row immediately.
  const refreshFolder = async (path) => {
    const featuresStore = useFeaturesStore();
    await featuresStore.ensureLoaded();
    if (!featuresStore.folderSizeEnabled) return null;

    const raw = await refreshFolderSize(path);
    const entry = normalizeEntry(raw);
    if (!entry.path) return null;
    sizes.value = { ...sizes.value, [entry.path]: entry };
    return entry;
  };

  return {
    sizes,
    isLoading,
    refresh,
    ensureSizes,
    scheduleRefresh,
    refreshFolder,
    setPaths,
    sizeFor,
  };
});
