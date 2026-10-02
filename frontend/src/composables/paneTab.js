import { computed, inject, provide, reactive } from 'vue';
import { useTabsStore } from '@/stores/tabs';
import { useFileStore } from '@/stores/fileStore';
import { tabFolderPath } from '@/config/tabKinds';

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
  const folder = computed(() => fileStore.folderFor(tabId.value));
  const tabsStore = useTabsStore();

  /** The address this pane's tab is on, which is what the strip shows for it. */
  const address = computed(() => tabsStore.tabs.find((tab) => tab.id === tabId.value)?.path || '');

  /** One of the folder's own refs, readable and writable through the pane. */
  const asRef = (pick) =>
    computed({
      get: () => pick(folder.value).value,
      set: (value) => {
        pick(folder.value).value = value;
      },
    });

  /**
   * The pane's own folder under the names the store already uses for the one in
   * front, and `reactive` so a ref unwraps on access exactly as a store's does.
   *
   * Which is the point: a screen that read `fileStore.selectedItems` reads
   * `pane.selectedItems` and nothing else about it changes — same shape, same
   * assignment, same template. A facade with different ergonomics would have
   * turned a rename into a rewrite of the largest view in the application, and
   * every `.value` forgotten along the way into a silent no-op.
   */
  const view = reactive({
    currentPath: computed(() => folder.value.path.value),
    currentPathData: computed(() => folder.value.data.value),
    getCurrentPathItems: computed(() => fileStore.arrange(folder.value.items.value)),
    selectedItems: asRef((one) => one.selection.selectedItems),
    selectedItemKeys: computed(() => folder.value.selection.selectedItemKeys.value),
    renameState: asRef((one) => one.rename.renameState),
    setKeyboardActionItem: (...args) => folder.value.selection.setKeyboardActionItem(...args),
    clearKeyboardActionItem: () => folder.value.selection.clearKeyboardActionItem(),
    prefetchItemThumbnail: (...args) => folder.value.thumbnails.prefetchItemThumbnail(...args),
    fetchPathItems: (...args) => folder.value.fetchItems(...args),
  });

  return {
    tabId,
    folder,
    address,
    view,
    /** Where the pane is, as the application names folders: `Docs/2026`. */
    folderPath: computed(() => tabFolderPath({ kind: 'folder', path: address.value })),
    /** Its listing, ordered the way the reader asked for. */
    items: computed(() => fileStore.arrange(folder.value.items.value)),
    /** Whether the reader is in this pane, which is what makes it act. */
    focused: computed(() => tabId.value === tabsStore.activeId),
  };
};
