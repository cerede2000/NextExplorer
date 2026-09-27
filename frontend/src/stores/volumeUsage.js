import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getUsage, getVolumes, normalizePath } from '@/api';
import { useFeaturesStore } from '@/stores/features';

const REFRESH_THROTTLE_MS = 2500;

const normalizeUsage = (raw = {}) => {
  const total = Number(raw.total) || 0;
  const used = Number(raw.used ?? raw.size) || 0;
  const free = Number(raw.free) || 0;
  const percentUsed =
    total > 0 ? Math.max(0, Math.min(100, Number(raw.percentUsed) || (used / total) * 100)) : 0;

  return {
    path: normalizePath(raw.path || ''),
    size: used,
    used,
    free,
    total,
    percentUsed,
  };
};

export const useVolumeUsageStore = defineStore('volumeUsage', () => {
  const volumes = ref([]);
  const usage = ref({});
  const isLoadingVolumes = ref(false);
  const isLoadingUsage = ref(false);
  const hasLoadedVolumes = ref(false);

  let loadPromise = null;
  let refreshPromise = null;
  let refreshTimer = null;
  let lastRefreshAt = 0;

  const setUsage = (path, value) => {
    const key = normalizePath(path || value?.path || '');
    if (!key) return;
    usage.value = {
      ...usage.value,
      [key]: normalizeUsage({ ...value, path: key }),
    };
  };

  const refreshUsage = async ({ force = false, skipLoad = false } = {}) => {
    const featuresStore = useFeaturesStore();
    await featuresStore.ensureLoaded();

    if (!featuresStore.volumeUsageEnabled) {
      usage.value = {};
      return;
    }

    if (!volumes.value.length && !skipLoad) {
      await loadVolumes({ force: false });
      return;
    }

    const now = Date.now();
    if (!force && now - lastRefreshAt < REFRESH_THROTTLE_MS) {
      return;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    const targetVolumes = [...volumes.value];
    isLoadingUsage.value = true;
    refreshPromise = (async () => {
      const entries = await Promise.all(
        targetVolumes.map(async (volume) => {
          try {
            const data = await getUsage(volume.path);
            return [normalizePath(volume.path), normalizeUsage(data)];
          } catch (_) {
            return null;
          }
        })
      );

      const nextUsage = { ...usage.value };
      for (const entry of entries) {
        if (!entry) continue;
        const [path, data] = entry;
        nextUsage[path] = data;
      }
      usage.value = nextUsage;
      lastRefreshAt = Date.now();
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
      isLoadingUsage.value = false;
    }
  };

  const loadVolumes = async ({ force = false } = {}) => {
    if (loadPromise) {
      return loadPromise;
    }
    if (!force && volumes.value.length) {
      return;
    }

    isLoadingVolumes.value = true;
    loadPromise = (async () => {
      const featuresStore = useFeaturesStore();
      await featuresStore.ensureLoaded();

      volumes.value = await getVolumes();
      hasLoadedVolumes.value = true;

      if (featuresStore.volumeUsageEnabled) {
        await refreshUsage({ force: true, skipLoad: true });
      }
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
      isLoadingVolumes.value = false;
    }
  };

  const scheduleRefresh = ({ delayMs = 500, force = true } = {}) => {
    if (refreshTimer) {
      globalThis.clearTimeout(refreshTimer);
    }
    refreshTimer = globalThis.setTimeout(() => {
      refreshTimer = null;
      refreshUsage({ force }).catch(() => {});
    }, delayMs);
  };

  return {
    volumes,
    usage,
    isLoadingVolumes,
    isLoadingUsage,
    hasLoadedVolumes,
    loadVolumes,
    refreshUsage,
    scheduleRefresh,
    setUsage,
  };
});
