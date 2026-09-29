import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useTabGuardsStore } from './tabGuards';

/**
 * A tab that has something to say before it is closed.
 *
 * Closing is the one gesture that destroys what a tab was holding, and the tabs store
 * cannot know whether that matters: it holds addresses, not work. So a screen with
 * something to lose leaves a question, and whoever closes a tab asks it — while a tab
 * nobody asked about closes as it always has, because being asked about a folder would
 * train everybody to click through the question without reading it.
 */

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('a question left for a tab', () => {
  it('is asked when that tab is closed', () => {
    const guards = useTabGuardsStore();
    const ask = vi.fn(() => false);
    guards.guard('tab-1', ask);

    expect(guards.mayClose('tab-1')).toBe(false);
    expect(ask).toHaveBeenCalled();
  });

  it('lets the tab go when the answer is yes', () => {
    const guards = useTabGuardsStore();
    guards.guard('tab-1', () => true);

    expect(guards.mayClose('tab-1')).toBe(true);
  });

  it('is not asked of any other tab', () => {
    const guards = useTabGuardsStore();
    guards.guard('tab-1', () => false);

    expect(guards.mayClose('tab-9')).toBe(true);
  });

  /** Nearly every tab: being asked about a folder is a question nobody reads. */
  it('is nothing at all for a tab nobody asked about', () => {
    expect(useTabGuardsStore().mayClose('tab-1')).toBe(true);
  });

  it('is taken back the way it was given', () => {
    const guards = useTabGuardsStore();
    const release = guards.guard('tab-1', () => false);

    release();

    expect(guards.mayClose('tab-1')).toBe(true);
  });

  /** A screen that has moved on must not be able to take back the next one's. */
  it('is taken back by whoever left it, and by nobody else', () => {
    const guards = useTabGuardsStore();
    const release = guards.guard('tab-1', () => true);
    guards.guard('tab-1', () => false);

    release();

    expect(guards.mayClose('tab-1')).toBe(false);
  });

  it('is let go when the tab is closed for good', () => {
    const guards = useTabGuardsStore();
    guards.guard('tab-1', () => false);

    guards.release('tab-1');

    expect(guards.mayClose('tab-1')).toBe(true);
  });

  /**
   * A screen with a broken question must not be able to make a tab unclosable: the
   * reader would have no way out of it at all.
   */
  it('lets the tab go when the question itself goes wrong', () => {
    const guards = useTabGuardsStore();
    guards.guard('tab-1', () => {
      throw new Error('broken');
    });

    expect(guards.mayClose('tab-1')).toBe(true);
  });

  it('is nothing for a tab with no id, and nothing for something that is not a question', () => {
    const guards = useTabGuardsStore();

    expect(() => guards.guard('', () => false)()).not.toThrow();
    expect(() => guards.guard('tab-1', null)()).not.toThrow();
    expect(guards.mayClose('tab-1')).toBe(true);
  });
});
