import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQuickActionsStore } from '@/stores/quickActions';
import { QUICK_ACTION_IDS, DEFAULT_QUICK_ACTIONS_ON } from '@/config/quickActions';

describe('quickActions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reset seeds the full catalog in order with the default enabled set', () => {
    const store = useQuickActionsStore();
    store.reset();

    expect(store.enabled).toBe(true);
    expect(store.config.map((e) => e.id)).toEqual(QUICK_ACTION_IDS);
    expect(store.enabledActionIds).toEqual(
      QUICK_ACTION_IDS.filter((id) => DEFAULT_QUICK_ACTIONS_ON.includes(id))
    );
  });

  it('setActionOn toggles a single action in/out of the enabled list', () => {
    const store = useQuickActionsStore();
    store.reset();

    store.setActionOn('info', false);
    expect(store.enabledActionIds).not.toContain('info');

    store.setActionOn('copyPath', true); // off by default
    expect(store.enabledActionIds).toContain('copyPath');
  });

  it('enabledActionIds is empty when the feature is disabled', () => {
    const store = useQuickActionsStore();
    store.reset();
    expect(store.enabledActionIds.length).toBeGreaterThan(0);

    store.setEnabled(false);
    expect(store.enabledActionIds).toEqual([]);
  });

  it('move reorders actions and the enabled list follows the new order', () => {
    const store = useQuickActionsStore();
    store.reset();

    const [first, second] = store.config.map((e) => e.id);
    store.move(second, -1); // pull the 2nd action above the 1st
    expect(store.config.slice(0, 2).map((e) => e.id)).toEqual([second, first]);

    // Both default-on, so their relative order in enabledActionIds also flips.
    const enabled = store.enabledActionIds;
    expect(enabled.indexOf(second)).toBeLessThan(enabled.indexOf(first));
  });

  it('move is a no-op at the boundaries', () => {
    const store = useQuickActionsStore();
    store.reset();
    const before = store.config.map((e) => e.id);

    store.move(before[0], -1); // already first
    store.move(before[before.length - 1], 1); // already last
    expect(store.config.map((e) => e.id)).toEqual(before);
  });

  it('config always resolves to exactly the catalog with no duplicates', () => {
    const store = useQuickActionsStore();
    store.reset();
    const ids = store.config.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual([...QUICK_ACTION_IDS].sort()); // exactly the catalog
  });
});
