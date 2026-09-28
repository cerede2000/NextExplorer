import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { nextTick } from 'vue';

/**
 * The tabs, and which of them is in front.
 *
 * What is worth holding here is the arithmetic nobody thinks about until it is
 * wrong: which tab takes over when the one in front closes, where a new tab
 * lands, that the last one cannot be closed because there would be nowhere to be,
 * and that what was stored is read back as something openable rather than
 * trusted. The store navigates nothing, which is why all of this can be asserted
 * without a router.
 */

const userSettings = ref({ browseInTabs: true });
// `loaded` matters: before the settings arrive, `browseInTabs` is not false but
// unknown, and the store is careful about the difference.
const loaded = ref(true);
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({
    get userSettings() {
      return userSettings.value;
    },
    get loaded() {
      return loaded.value;
    },
  }),
}));

import { HOME, useTabsStore } from './tabs';

const paths = (store) => store.tabs.map((tab) => tab.path);

beforeEach(() => {
  localStorage.clear();
  userSettings.value = { browseInTabs: true };
  loaded.value = true;
  setActivePinia(createPinia());
});

describe('what a fresh window holds', () => {
  it('is one tab, at the volumes', () => {
    const store = useTabsStore();

    expect(store.count).toBe(1);
    expect(store.activeTab).toMatchObject({ kind: 'folder', path: HOME });
    expect(store.activeId).toBe(store.tabs[0].id);
  });

  it('cannot close it: there would be nowhere to be', () => {
    const store = useTabsStore();

    expect(store.canClose).toBe(false);
    expect(store.close(store.activeId)).toBeNull();
    expect(store.count).toBe(1);
  });
});

describe('what was stored is read back as something openable', () => {
  const store = (open, active = '') => {
    localStorage.setItem('settings:tabs:open', JSON.stringify(open));
    localStorage.setItem('settings:tabs:active', JSON.stringify(active));
    setActivePinia(createPinia());
    return useTabsStore();
  };

  it('keeps the tabs that are still tabs', () => {
    const kept = store([
      { id: 'a', kind: 'folder', path: '/browse/Docs' },
      { id: 'b', kind: 'trash', path: '/trash' },
    ]);

    expect(paths(kept)).toEqual(['/browse/Docs', '/trash']);
  });

  it('drops a kind that no longer exists, and an entry that is not one', () => {
    const kept = store([
      { id: 'a', kind: 'folder', path: '/browse/Docs' },
      { id: 'b', kind: 'telepathy', path: '/wherever' },
      { id: 'c', path: '/browse/Media' },
      null,
      'nonsense',
    ]);

    expect(paths(kept)).toEqual(['/browse/Docs']);
  });

  /** Somebody who closed the browser on a settings page was not mid-anything. */
  it('does not bring back a kind that says it should not come back', () => {
    const kept = store([
      { id: 'a', kind: 'settings', path: '/settings/about' },
      { id: 'b', kind: 'search', path: '/search?q=x' },
      { id: 'c', kind: 'folder', path: '/browse/Docs' },
    ]);

    expect(paths(kept)).toEqual(['/browse/Docs']);
  });

  it('opens one tab when nothing survived', () => {
    const kept = store([{ id: 'a', kind: 'settings', path: '/settings/about' }]);

    expect(paths(kept)).toEqual([HOME]);
  });

  it('puts a tab in front that is there', () => {
    const kept = store(
      [
        { id: 'a', kind: 'folder', path: '/browse/Docs' },
        { id: 'b', kind: 'folder', path: '/browse/Media' },
      ],
      'gone'
    );

    expect(kept.activeId).toBe('a');
  });

  /**
   * Asserted as the next visit sees it rather than as the bytes in storage: what
   * matters is that a window opened again finds the tabs, and `useStorage` writes
   * on its own schedule.
   */
  it('writes what it holds, so the next visit finds it', async () => {
    const opened = useTabsStore();
    opened.open('/browse/Docs');
    const wasActive = opened.activeId;
    await nextTick();

    setActivePinia(createPinia());
    const returning = useTabsStore();

    expect(paths(returning)).toEqual([HOME, '/browse/Docs']);
    expect(returning.activeId).toBe(wasActive);
  });
});

describe('opening a tab', () => {
  it('lands it immediately after the one it was opened from', () => {
    const store = useTabsStore();
    store.open('/browse/A');
    store.activate(store.tabs[0].id);
    store.open('/browse/B');

    expect(paths(store)).toEqual([HOME, '/browse/B', '/browse/A']);
  });

  it('leaves the reader where they were when asked to', () => {
    const store = useTabsStore();
    const first = store.activeId;
    const tab = store.open('/browse/A', { activate: false });

    expect(store.activeId).toBe(first);
    expect(tab.path).toBe('/browse/A');
  });

  it('brings forward the one screen there is only one of', () => {
    const store = useTabsStore();
    const trash = store.open('/trash');
    store.activate(store.tabs[0].id);

    const again = store.open('/trash');

    expect(again.id).toBe(trash.id);
    expect(store.count).toBe(2);
    expect(store.activeId).toBe(trash.id);
  });

  it('refuses an address no tab can be on', () => {
    const store = useTabsStore();

    expect(store.open('/auth/login')).toBeNull();
    expect(store.count).toBe(1);
  });

  /** With the mode off there is one tab and it goes where it is told. */
  it('moves the one tab when tabs are off', () => {
    userSettings.value = { browseInTabs: false };
    const store = useTabsStore();

    const tab = store.open('/browse/Docs');

    expect(store.count).toBe(1);
    expect(tab.path).toBe('/browse/Docs');
    expect(tab.kind).toBe('folder');
  });
});

describe('closing a tab', () => {
  const three = () => {
    const store = useTabsStore();
    store.open('/browse/A');
    store.open('/browse/B');
    return store;
  };

  it('hands over to the one on its right', () => {
    const store = three();
    store.activate(store.tabs[1].id);

    const now = store.close(store.tabs[1].id);

    expect(now.path).toBe('/browse/B');
    expect(paths(store)).toEqual([HOME, '/browse/B']);
  });

  it('hands over to the left when there is no right', () => {
    const store = three();
    const last = store.tabs[2].id;
    store.activate(last);

    const now = store.close(last);

    expect(now.path).toBe('/browse/A');
  });

  it('moves nobody when the tab closed was not in front', () => {
    const store = three();
    const inFront = store.activeId;

    expect(store.close(store.tabs[0].id)).toBeNull();
    expect(store.activeId).toBe(inFront);
  });

  it('leaves one when asked to close the others', () => {
    const store = three();
    const keep = store.tabs[0].id;

    store.closeOthers(keep);

    expect(store.count).toBe(1);
    expect(store.activeId).toBe(keep);
  });
});

describe('finding the next tab', () => {
  it('wraps in both directions', () => {
    const store = useTabsStore();
    store.open('/browse/A');
    store.open('/browse/B');
    store.activate(store.tabs[2].id);

    expect(store.neighbour(1).path).toBe(HOME);
    expect(store.neighbour(-1).path).toBe('/browse/A');
  });

  it('has no neighbour to find with one tab', () => {
    expect(useTabsStore().neighbour(1)).toBeNull();
  });

  it('counts from one, as a reader would', () => {
    const store = useTabsStore();
    store.open('/browse/A');

    expect(store.at(1).path).toBe(HOME);
    expect(store.at(2).path).toBe('/browse/A');
    expect(store.at(3)).toBeNull();
  });
});

describe('the tab in front follows the address', () => {
  it('becomes whatever the router is showing', () => {
    const store = useTabsStore();

    store.syncActive('/trash');

    expect(store.activeTab).toMatchObject({ kind: 'trash', path: '/trash' });
    expect(store.count).toBe(1);
  });

  it('is left alone by an address no tab can be on', () => {
    const store = useTabsStore();
    store.syncActive('/browse/Docs');

    store.syncActive('/auth/login');

    expect(store.activeTab).toMatchObject({ kind: 'folder', path: '/browse/Docs' });
  });
});

describe('turning the mode off', () => {
  it('leaves the tab in front and nothing kept behind it', async () => {
    const store = useTabsStore();
    store.open('/browse/A');
    const inFront = store.activeId;
    expect(store.count).toBe(2);

    userSettings.value = { browseInTabs: false };
    await nextTick();

    expect(store.count).toBe(1);
    expect(store.activeId).toBe(inFront);
  });
});
