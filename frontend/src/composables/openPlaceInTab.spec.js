import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Somewhere to be, opened in a tab behind.
 *
 * The middle button on a folder row has meant this since tabs existed, and the
 * four other ways into a folder — a favourite and a volume in the sidebar, a
 * favourite and a volume on the home page — should mean the same thing. One rule,
 * asked by all of them, or the gesture works in one place and not the next.
 */

import { useOpenPlaceInTab } from './openPlaceInTab';
import { useTabsStore } from '@/stores/tabs';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('opening a place in a tab', () => {
  it('opens it, and leaves the reader where they were', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    tabs.syncActive('/browse/Projects');
    const { openPlaceInTab } = useOpenPlaceInTab();

    expect(openPlaceInTab('Photos/2026')).toBe(true);

    expect(tabs.tabs.map((tab) => tab.path)).toContain('/browse/Photos/2026');
    // Behind: somebody lining up three volumes is still looking at the first.
    expect(tabs.activeTab.path).toBe('/browse/Projects');
  });

  /** A tab opened *for* a place, which is what lets a document in it close it. */
  it('marks the tab as opened for that place', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const { openPlaceInTab } = useOpenPlaceInTab();

    openPlaceInTab('Photos');

    expect(tabs.tabs.find((tab) => tab.path === '/browse/Photos').own).toBe(true);
  });

  it('writes the address the way a person would', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const { openPlaceInTab } = useOpenPlaceInTab();

    openPlaceInTab('Stacks/data set');

    // Each segment encoded on its own, so the slashes between them survive.
    expect(tabs.tabs.map((tab) => tab.path)).toContain('/browse/Stacks/data%20set');
  });

  /** With tabs off there is nothing to open one in: the ordinary click stands. */
  it('does nothing, and says so, when tabs are off', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(false);
    const before = tabs.tabs.map((tab) => tab.path);
    const { openPlaceInTab } = useOpenPlaceInTab();

    expect(openPlaceInTab('Photos')).toBe(false);

    expect(tabs.tabs.map((tab) => tab.path)).toEqual(before);
  });

  it('does nothing for a favourite that has no path', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const { openPlaceInTab } = useOpenPlaceInTab();

    expect(openPlaceInTab('')).toBe(false);
    expect(openPlaceInTab(undefined)).toBe(false);
    expect(tabs.count).toBe(1);
  });
});
