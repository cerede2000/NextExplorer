import { folderRoute } from '@/utils/folderRoute';
import { useTabsStore } from '@/stores/tabs';

/**
 * A place, opened in a tab behind.
 *
 * The middle button on a folder row has done this since tabs existed, and every
 * other way into a folder should mean the same thing: a favourite, a volume in
 * the sidebar, a volume on the home page, the personal folder. They are all one
 * gesture on one kind of thing — somewhere to be — so the rule is written once
 * and the four of them ask it.
 *
 * Behind rather than in front, which is the whole point: somebody lining up three
 * volumes to compare wants to still be looking at the one they were on. And only
 * with tabs on; without them, answering false leaves the ordinary click to do
 * what it has always done.
 *
 * `own` says the tab exists *for* this place, which is what lets a document
 * opened in it close it again later — see `stores/tabs.js`.
 */
export function useOpenPlaceInTab() {
  /**
   * Open a folder path in a tab behind, and say whether it did.
   *
   * The store is asked for when the gesture happens rather than when the screen
   * is built. The sidebar's favourites and volumes are on every page, and
   * reaching for pinia from their setup would put it in the module graph of
   * screens that have no idea about tabs — which is how three suites that had
   * mocked their own stores and nothing else stopped loading at all.
   *
   * @param {string} path  A folder path, as a favourite or a volume names it.
   */
  const openPlaceInTab = (path) => {
    if (!path) return false;
    const tabs = useTabsStore();
    if (!tabs.enabled) return false;
    return Boolean(tabs.open(folderRoute(path).path, { activate: false, own: true }));
  };

  return { openPlaceInTab };
}
