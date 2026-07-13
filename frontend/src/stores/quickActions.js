import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import {
  QUICK_ACTION_IDS,
  DEFAULT_QUICK_ACTIONS_ON,
  defaultQuickActionConfig,
} from '@/config/quickActions';

// User configuration for the inline quick-actions menu. Persisted client-side
// (localStorage) since it is a per-device UI preference. Holds an on/off master
// switch plus an ordered list of { id, on } describing which actions appear and
// in what order — reconciled against the catalog so the stored value survives
// catalog changes (new actions appear, removed ones drop out).
export const useQuickActionsStore = defineStore('quickActions', () => {
  const enabled = useStorage('settings:quickActions:enabled', true);
  const rawConfig = useStorage('settings:quickActions:config', defaultQuickActionConfig());

  const config = computed(() => {
    const known = new Set(QUICK_ACTION_IDS);
    const seen = new Set();
    const result = [];
    for (const entry of Array.isArray(rawConfig.value) ? rawConfig.value : []) {
      if (entry && known.has(entry.id) && !seen.has(entry.id)) {
        result.push({ id: entry.id, on: Boolean(entry.on) });
        seen.add(entry.id);
      }
    }
    // Append catalog actions missing from storage (keeps new actions visible).
    for (const id of QUICK_ACTION_IDS) {
      if (!seen.has(id)) result.push({ id, on: DEFAULT_QUICK_ACTIONS_ON.includes(id) });
    }
    return result;
  });

  const enabledActionIds = computed(() =>
    enabled.value ? config.value.filter((entry) => entry.on).map((entry) => entry.id) : []
  );

  const hasAnyEnabled = computed(() => enabledActionIds.value.length > 0);

  const persist = (next) => {
    rawConfig.value = next.map((entry) => ({ id: entry.id, on: Boolean(entry.on) }));
  };

  const setEnabled = (value) => {
    enabled.value = Boolean(value);
  };

  const setActionOn = (id, on) => {
    persist(config.value.map((entry) => (entry.id === id ? { ...entry, on: Boolean(on) } : entry)));
  };

  // Move an action one slot up (dir=-1) or down (dir=+1).
  const move = (id, dir) => {
    const arr = config.value.slice();
    const i = arr.findIndex((entry) => entry.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    persist(arr);
  };

  const reset = () => {
    enabled.value = true;
    persist(defaultQuickActionConfig());
  };

  return {
    enabled,
    config,
    enabledActionIds,
    hasAnyEnabled,
    setEnabled,
    setActionOn,
    move,
    reset,
  };
});
