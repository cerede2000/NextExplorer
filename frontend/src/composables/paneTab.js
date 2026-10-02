import { computed, inject, provide } from 'vue';
import { useTabsStore } from '@/stores/tabs';
import { useFileStore } from '@/stores/fileStore';

/**
 * Which tab a pane is drawing.
 *
 * A screen draws a *place*, and in a split view the place it draws is its own
 * pane's tab — not whichever tab happens to have focus. Everything that acts for
 * the *person* keeps reading the store's own surface, which follows the tab in
 * front: the clipboard, the operations, the toolbar's buttons. The line is the
 * same one `files/folderTab.js` already draws, and this is how a component on the
 * far side of it asks which side it is on.
 *
 * Passed down rather than looked up, because a pane cannot be recognised from
 * anywhere else: both panes render the same components, at the same addresses,
 * from the same store.
 */
const PANE_TAB = Symbol('pane-tab-id');

/** Said by whoever draws a pane, once, with a ref so the pane can change tabs. */
export const providePaneTab = (tabId) => {
  provide(
    PANE_TAB,
    computed(() => tabId.value)
  );
};

/**
 * The tab this component belongs to.
 *
 * Falls back to the tab in front, which is what every screen outside a pane
 * wants and what every screen wanted before panes existed: one pane, and it
 * holds the tab in front. So a component may ask without knowing whether
 * anybody is answering.
 */
export const usePaneTabId = () => {
  const provided = inject(PANE_TAB, null);
  const tabsStore = useTabsStore();
  return computed(() => provided?.value || tabsStore.activeId);
};

/**
 * The folder this component's tab is on — its listing, its selection, its
 * rename, its thumbnails.
 *
 * The same object the store reads for the tab in front, so a component that
 * takes this instead of the store's surface behaves identically in a window
 * with one pane, and correctly in a window with two.
 */
export const usePaneFolder = () => {
  const fileStore = useFileStore();
  const tabId = usePaneTabId();
  return {
    tabId,
    folder: computed(() => fileStore.folderFor(tabId.value)),
  };
};
