import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { HOME, useTabsStore } from '@/stores/tabs';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';
import { tabKindForPath } from '@/config/tabKinds';

/**
 * The tabs and the address bar, kept in step.
 *
 * One rule, and everything else follows from it: **the router says where we are,
 * and the tab in front says the same thing**. Walking into a folder does not
 * touch the tabs — it changes the address, and the active tab follows. Bringing
 * another tab forward is the other direction: the tab says where it was, and that
 * address is pushed.
 *
 * Which is why the store never navigates and this does: one place decides what
 * the address bar says, and the store stays something a test can hold without a
 * router.
 *
 * On the keyboard, deliberately nothing. Every shortcut a tabbed window wants —
 * ctrl+T, ctrl+W, ctrl+Tab, ctrl+1 — belongs to the browser, which takes them
 * before a page is asked and cannot be talked out of it. Offering them here would
 * be offering something that works in one browser out of three. The gestures that
 * do work are the ones a browser itself teaches: the middle button opens a place
 * in a tab behind, and the modifier does the same for somebody without one.
 */
/**
 * The tab in front follows the address. Installed **once**, where the application
 * is — not where a tab is used.
 *
 * The first version of this lived in the actions below, and every folder row that
 * wanted the middle-button gesture would have installed another copy: one watcher
 * per row of the listing, all saying the same thing to the same store.
 */
export function useTabRouteSync() {
  const tabs = useTabsStore();
  const appSettings = useAppSettings();
  const route = useRoute();

  // The address is the truth. `immediate` so the tab in front starts out saying
  // where the page was opened, however it was reached — a deep link included.
  watch(
    () => route.fullPath,
    (path) => tabs.syncActive(path),
    { immediate: true }
  );

  /**
   * And the account's answer about tabs, told to the store once it is known.
   *
   * `loaded` is the whole point. Before the settings arrive `browseInTabs` is not
   * false, it is *unknown*, and telling the store "off" then threw away every tab
   * the reader had — on every page load, a moment before the answer came.
   */
  watch(
    () => [appSettings.loaded, appSettings.userSettings?.browseInTabs],
    ([ready, on]) => {
      if (ready) tabs.setEnabled(on === true);
    },
    { immediate: true }
  );

  /**
   * And how many of them this installation allows, which is an administrator's
   * answer rather than an account's — told the same way, and from the same place,
   * so the store still knows nothing about where either comes from.
   */
  const features = useFeaturesStore();
  watch(
    () => features.maxTabs,
    (many) => tabs.setLimit(many),
    { immediate: true }
  );

  /**
   * And the tabs that came back with the window, got ready once.
   *
   * A reader who left four documents open and returns finds them open again —
   * which until now meant four addresses and four waits, one per tab as they
   * reached it. Done once rather than watched: the tabs that were restored are
   * the ones that were there when the settings arrived, and every tab opened
   * after that is the gesture's own business.
   *
   * Never the tab in front: the router is already drawing it.
   */
  let warmedOnce = false;
  watch(
    () => [appSettings.loaded, appSettings.userSettings?.browseInTabs],
    ([ready, on]) => {
      if (warmedOnce || !ready || on !== true) return;
      if (appSettings.userSettings?.preloadBackgroundTabs === false) return;
      warmedOnce = true;
      const behind = tabs.tabs.filter((tab) => tab.id !== tabs.activeId).map((tab) => ({ ...tab }));
      if (behind.length > 0) void warmInBackground(behind);
    },
    { immediate: true }
  );
}

/**
 * Getting tabs ready before the reader arrives at them.
 *
 * Everything it needs is fetched when it is needed, not imported here. Reaching
 * for the preview manager from this file would put it — and the router, and the
 * plugins — into the module graph of every screen that draws a tab, which is how
 * three suites that had mocked their own stores and nothing else stopped loading
 * at all. Nothing is loaded until a tab is actually opened in the background.
 */
const warmInBackground = async (toWarm) => {
  const candidates = (Array.isArray(toWarm) ? toWarm : [toWarm]).filter(Boolean);
  if (candidates.length === 0) return [];

  const [{ warmTabs }, { useFileStore }, { usePreviewManager }, { useTerminalStore }, api] =
    await Promise.all([
      import('@/composables/tabWarmup'),
      import('@/stores/fileStore'),
      import('@/plugins/preview/manager'),
      import('@/stores/terminal'),
      import('@/api'),
    ]);

  return warmTabs(candidates, {
    fileStore: useFileStore(),
    previewManager: usePreviewManager(),
    terminalStore: useTerminalStore(),
    readFile: api.fetchFileContent,
  });
};

/** The actions, safe to ask for anywhere: no watchers, nothing installed. */
export function useTabNavigation() {
  const tabs = useTabsStore();
  const router = useRouter();
  const route = useRoute();
  const appSettings = useAppSettings();

  /**
   * Whether this account asked for tabs to be got ready in advance.
   *
   * On unless it is turned off, and only once the settings have arrived: before
   * that the answer is not "no", it is *unknown*, and acting on the wrong one here
   * would open editing sessions nobody asked for.
   */
  const warmsAhead = () =>
    appSettings.loaded && appSettings.userSettings?.preloadBackgroundTabs !== false;

  /** Go where a tab says it is, unless that is already where we are. */
  const go = (tab) => {
    if (tab && tab.path && tab.path !== route.fullPath) void router.push(tab.path);
    return tab;
  };

  const activate = (id) => go(tabs.activate(id));

  /**
   * Open an address in a tab.
   *
   * `behind` is the middle-button gesture: the tab is made and the reader is left
   * where they were, which is how somebody queues up four folders to look at.
   */
  const open = (path, { behind = false, own = false } = {}) => {
    const tab = tabs.open(path, { activate: !behind, own });
    // Opened behind on purpose, which is exactly when there is time to get it
    // ready: the reader is still looking at something else.
    if (tab && behind && warmsAhead()) void warmInBackground([{ ...tab }]);
    return behind ? tab : go(tab);
  };

  const openHome = () => open(HOME);

  const close = (id) => go(tabs.close(id));
  const closeOthers = (id) => go(tabs.closeOthers(id));
  /** Every one of them, and a new tab at the volumes to land in. */
  const closeAll = () => go(tabs.closeAll());

  /**
   * Close the tab that exists *for* what is on screen, and say whether it did.
   *
   * What the close button of a document means, and it means it in two places —
   * the preview and the text editor — which is why it is here and not in either
   * of them. In a tab opened for this file, closing the file is closing the tab;
   * anywhere else the caller does what it always did.
   *
   * Three things make it refuse, and each of them would take something away from
   * whoever pressed the button: tabs turned off, a tab that was merely taken here
   * while somebody was browsing (`own` stops being true the moment it is), and the
   * last tab, because there would be nowhere left to be.
   */
  const closeOwn = () => {
    if (!tabs.enabled) return false;
    const tab = tabs.activeTab;
    if (!tab?.own || !tabs.canClose) return false;
    close(tab.id);
    return true;
  };

  /** Whether the strip belongs on screen at all: the mode, and a place to be. */
  const visible = computed(() => tabs.enabled && Boolean(tabKindForPath(route.fullPath)));

  return { tabs, visible, activate, open, openHome, close, closeOthers, closeAll, closeOwn };
}
