import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQuickActionsStore } from '@/stores/quickActions';
import { QUICK_ACTION_IDS, DEFAULT_QUICK_ACTIONS_ON } from '@/config/quickActions';

const defaultOnIds = QUICK_ACTION_IDS.filter((id) => DEFAULT_QUICK_ACTIONS_ON.includes(id));

describe('quickActions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('is disabled by default', () => {
    const store = useQuickActionsStore();
    // Fresh store (no stored preference) ships with the feature off.
    expect(store.enabled).toBe(false);
    expect(store.enabledActionIds).toEqual([]);
  });

  it('reset restores the default (disabled) config: full catalog in order, default on-set', () => {
    const store = useQuickActionsStore();
    store.setEnabled(true);
    store.reset();

    // Reset is a factory reset — it also turns the feature back off (the default).
    expect(store.enabled).toBe(false);
    // The action selection/order is independent of the master switch.
    expect(store.config.map((e) => e.id)).toEqual(QUICK_ACTION_IDS);
    expect(store.config.filter((e) => e.on).map((e) => e.id)).toEqual(defaultOnIds);
  });

  it('enabledActionIds reflects the default on-set once enabled', () => {
    const store = useQuickActionsStore();
    store.reset();
    store.setEnabled(true);
    expect(store.enabledActionIds).toEqual(defaultOnIds);
  });

  it('setActionOn toggles a single action in/out of the enabled list', () => {
    const store = useQuickActionsStore();
    store.reset();
    store.setEnabled(true);

    store.setActionOn('info', false);
    expect(store.enabledActionIds).not.toContain('info');

    store.setActionOn('copyPath', true); // off by default
    expect(store.enabledActionIds).toContain('copyPath');
  });

  it('enabledActionIds is empty when the feature is disabled', () => {
    const store = useQuickActionsStore();
    store.reset();
    store.setEnabled(true);
    expect(store.enabledActionIds.length).toBeGreaterThan(0);

    store.setEnabled(false);
    expect(store.enabledActionIds).toEqual([]);
  });

  it('move reorders actions and the enabled list follows the new order', () => {
    const store = useQuickActionsStore();
    store.reset();
    store.setEnabled(true);

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

/**
 * Where the icons sit, and the room the row keeps for them.
 *
 * The point of asking for them to be aligned is that they are in the same place
 * on every row, so the width is read from the actions the reader turned on and
 * not from the ones a particular row offers — and it is kept whether the row is
 * hovered or not, or the name would move the moment the pointer arrived.
 */
describe('where the quick actions sit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const ready = (position) => {
    const store = useQuickActionsStore();
    store.reset();
    store.setEnabled(true);
    store.setPosition(position);
    return store;
  };

  it('follows the name until asked otherwise', () => {
    const store = useQuickActionsStore();
    store.reset();
    expect(store.position).toBe('after');
    store.setEnabled(true);
    expect(store.alignedSlot).toBeNull();
  });

  it.each(['start', 'end'])('keeps a slot at the %s of the name column', (side) => {
    const store = ready(side);
    // Eight actions are on by default: eight 24px buttons with 2px between them.
    const width = defaultOnIds.length * 24 + (defaultOnIds.length - 1) * 2;
    expect(store.alignedSlot).toEqual({ side, width: `${width}px` });
  });

  it('measures the slot by what is turned on, not by what a row offers', () => {
    const store = ready('start');
    const before = store.alignedSlot.width;

    store.setActionOn('info', false);

    expect(store.alignedSlot.width).not.toBe(before);
    const count = defaultOnIds.length - 1;
    expect(store.alignedSlot.width).toBe(`${count * 24 + (count - 1) * 2}px`);
  });

  it('keeps no slot while the whole menu is off', () => {
    const store = ready('start');
    store.setEnabled(false);
    expect(store.alignedSlot).toBeNull();
  });

  it('keeps no slot when every action has been turned off', () => {
    const store = ready('end');
    for (const id of QUICK_ACTION_IDS) store.setActionOn(id, false);
    expect(store.alignedSlot).toBeNull();
  });

  /** A word this does not know would leave the rows laid out by nothing. */
  it('falls back to following the name when given a word it does not know', () => {
    const store = ready('end');
    store.setPosition('somewhere');
    expect(store.position).toBe('after');
    expect(store.alignedSlot).toBeNull();
  });

  it('is put back where it was by a reset', () => {
    const store = ready('start');
    store.reset();
    expect(store.position).toBe('after');
  });
});
