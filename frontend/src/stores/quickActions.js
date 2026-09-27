import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import {
  QUICK_ACTION_IDS,
  QUICK_ACTION_POSITIONS,
  DEFAULT_QUICK_ACTIONS_ON,
  defaultQuickActionConfig,
  quickActionsReservedWidth,
} from '@/config/quickActions';

// User configuration for the inline quick-actions menu. Persisted client-side
// (localStorage) since it is a per-device UI preference. Holds an on/off master
// switch plus an ordered list of { id, on } describing which actions appear and
// in what order — reconciled against the catalog so the stored value survives
// catalog changes (new actions appear, removed ones drop out).
export const useQuickActionsStore = defineStore('quickActions', () => {
  const enabled = useStorage('settings:quickActions:enabled', false);
  // 'full' = all icons appear on row hover; 'compact' = a "…" appears on hover
  // and expands to the icons when hovered.
  const displayMode = useStorage('settings:quickActions:mode', 'full');
  // 'after' = right of the name, where they have always been; 'start' / 'end' =
  // at an edge of the name column, which is what makes them line up down the list.
  const position = useStorage('settings:quickActions:position', 'after');
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

  /**
   * The room an aligned row keeps at one edge of its name column, or null when
   * the icons follow the name and there is nothing to keep.
   *
   * One answer for every row, from the actions the reader turned on rather than
   * from the ones a particular row happens to offer — a row reserving its own
   * width would put its name where no other row has it, which is the opposite of
   * what asking for them to be aligned meant.
   */
  const alignedSlot = computed(() => {
    if (!enabled.value) return null;
    if (position.value !== 'start' && position.value !== 'end') return null;
    const width = quickActionsReservedWidth(enabledActionIds.value.length);
    return width > 0 ? { side: position.value, width: `${width}px` } : null;
  });

  const persist = (next) => {
    rawConfig.value = next.map((entry) => ({ id: entry.id, on: Boolean(entry.on) }));
  };

  const setEnabled = (value) => {
    enabled.value = Boolean(value);
  };

  const setDisplayMode = (mode) => {
    displayMode.value = mode === 'compact' ? 'compact' : 'full';
  };

  // A word this does not know would leave the rows laid out by nothing, so it
  // falls back to where the icons were before there was a choice.
  const setPosition = (value) => {
    position.value = QUICK_ACTION_POSITIONS.includes(value) ? value : 'after';
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
    enabled.value = false;
    displayMode.value = 'full';
    position.value = 'after';
    persist(defaultQuickActionConfig());
  };

  return {
    enabled,
    displayMode,
    position,
    config,
    enabledActionIds,
    hasAnyEnabled,
    alignedSlot,
    setEnabled,
    setDisplayMode,
    setPosition,
    setActionOn,
    move,
    reset,
  };
});
