import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

import { providePaneTab, usePaneFolder, usePaneTabId } from './paneTab';
import { useTabsStore } from '@/stores/tabs';
import { useFileStore } from '@/stores/fileStore';

/**
 * Which tab a pane draws, which is the whole of what a split view costs the
 * screens inside it.
 *
 * The one case worth holding is the one that cannot happen with a single pane and
 * is wrong by default: a pane whose tab is *not* the tab in front still draws its
 * own. Everything that reads the store's own surface follows the tab in front,
 * and that is right for the clipboard and the toolbar — so the discriminating
 * assertion is not "it answers a tab", it is "it answers a tab that is not the
 * active one".
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

/** A pane, as the layout draws one, with a child that asks where it is. */
const paneHolding = (tabId) => {
  const seen = {};
  const Child = defineComponent({
    setup() {
      seen.id = usePaneTabId();
      seen.pane = usePaneFolder();
      return () => h('div');
    },
  });
  const Pane = defineComponent({
    setup() {
      providePaneTab(tabId);
      return () => h(Child);
    },
  });
  mount(Pane);
  return seen;
};

describe('the tab a pane draws', () => {
  it('is the tab in front, where nobody has said otherwise', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const second = tabs.open('/browse/Beta');

    const seen = paneHolding(ref(''));

    expect(seen.id.value).toBe(second.id);

    // And follows it, because that is what every screen outside a pane wants.
    tabs.activate(tabs.tabs[0].id);
    expect(seen.id.value).toBe(tabs.tabs[0].id);
  });

  /** The case a single pane cannot produce: drawing a tab that is not in front. */
  it('is the pane tab, even while another tab is in front', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const first = tabs.tabs[0];
    const second = tabs.open('/browse/Beta');
    tabs.activate(first.id);

    const seen = paneHolding(ref(second.id));

    expect(tabs.activeId).toBe(first.id);
    expect(seen.id.value).toBe(second.id);
  });

  it('changes with the pane, because a pane can be given another tab', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const first = tabs.tabs[0];
    const second = tabs.open('/browse/Beta');
    const held = ref(first.id);

    const seen = paneHolding(held);
    expect(seen.id.value).toBe(first.id);

    held.value = second.id;
    expect(seen.id.value).toBe(second.id);
  });

  /**
   * The facade reads and writes the pane's own folder, under the names the store
   * uses for the tab in front — which is what lets a screen move onto it by
   * renaming rather than by being rewritten.
   *
   * The assertion that matters is the write: a pane selecting something must not
   * select it in whichever tab happens to have focus.
   */
  it('selects in its own tab, not in the one in front', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const fileStore = useFileStore();
    const first = tabs.tabs[0];
    const second = tabs.open('/browse/Beta');
    tabs.activate(first.id);

    const seen = paneHolding(ref(second.id));
    const chosen = [{ name: 'notes.txt' }];
    seen.pane.view.selectedItems = chosen;

    expect(fileStore.folderFor(second.id).selection.selectedItems.value).toEqual(chosen);
    expect(fileStore.folderFor(first.id).selection.selectedItems.value).toEqual([]);
    // And the store's own surface, which follows focus, is untouched.
    expect(fileStore.selectedItems).toEqual([]);
  });

  /** A ref reached through the facade unwraps, as it does through a store. */
  it('reads a path without anybody remembering a .value', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const fileStore = useFileStore();
    const second = tabs.open('/browse/Beta');
    fileStore.folderFor(second.id).path.value = 'Beta';

    const seen = paneHolding(ref(second.id));

    expect(seen.pane.view.currentPath).toBe('Beta');
  });

  /**
   * And the folder it hands over is that tab's own — the listing, the selection
   * and the rename that belong to the place, not to whoever has focus.
   */
  it('hands over the folder belonging to its own tab', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const fileStore = useFileStore();
    const first = tabs.tabs[0];
    const second = tabs.open('/browse/Beta');
    tabs.activate(first.id);

    const seen = paneHolding(ref(second.id));

    expect(seen.pane.folder.value).toBe(fileStore.folderFor(second.id));
    expect(seen.pane.folder.value).not.toBe(fileStore.folderFor(first.id));
  });
});
