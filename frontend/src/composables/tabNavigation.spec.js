import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Closing the tab a document was opened for.
 *
 * The rule lives here because two crosses mean it — the preview's and the text
 * editor's — and a rule kept in two places is a rule that will disagree with
 * itself. It is also the rule with the most to lose if it is too eager: closing a
 * tab somebody had been browsing in, because they shut a document they happened
 * to open in it, takes a tab away from them and there is no undo.
 *
 * Held against the real tabs store rather than a stand-in, because `own` is the
 * whole of the question and it is the store that decides when it stops being
 * true.
 */

const push = vi.fn();
const route = { fullPath: '/browse/' };

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => route,
}));

/**
 * Getting a tab ready before the reader arrives at it.
 *
 * What this file owns is *when* — the gesture that opens a tab behind, and the
 * account's answer about whether that should happen at all. What it costs and what
 * each kind of tab does about it is `tabWarmup.js`, and its own suite.
 *
 * Everything the warming needs is fetched when it is needed rather than imported,
 * so that reaching for the preview manager from here does not put it into the
 * module graph of every screen that draws a tab. Standing in for those imports is
 * how that stays true in the test as well.
 */
const warmTabs = vi.hoisted(() => vi.fn(() => []));
vi.mock('@/composables/tabWarmup', () => ({ warmTabs, WARM_TAB_LIMIT: 3 }));
vi.mock('@/plugins/preview/manager', () => ({ usePreviewManager: () => ({}) }));
vi.mock('@/stores/terminal', () => ({ useTerminalStore: () => ({}) }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => ({ fetchIn: vi.fn() }) }));
vi.mock('@/api', () => ({ fetchFileContent: vi.fn() }));

const settings = vi.hoisted(() => ({ loaded: true, userSettings: {} }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => settings }));

import { useTabNavigation } from './tabNavigation';
import { useTabsStore } from '@/stores/tabs';

beforeEach(() => {
  setActivePinia(createPinia());
  push.mockClear();
  warmTabs.mockClear();
  settings.loaded = true;
  settings.userSettings = {};
  route.fullPath = '/browse/';
});

/** Tabs on, and a second tab opened *for* a document, in front. */
const withOwnDocumentTab = () => {
  const tabs = useTabsStore();
  tabs.setEnabled(true);
  const tab = tabs.open('/open/Docs/report.docx', { own: true });
  return { tabs, tab };
};

describe('closing the tab something was opened for', () => {
  it('closes it, and says so', () => {
    const { tabs, tab } = withOwnDocumentTab();
    const navigation = useTabNavigation();

    expect(navigation.closeOwn()).toBe(true);
    expect(tabs.tabs.some((entry) => entry.id === tab.id)).toBe(false);
  });

  /**
   * Taken somewhere else, so it is not a tab that exists for one thing any more.
   * The store stops saying `own` the moment the address changes; this is what
   * that is for.
   */
  it('leaves alone a tab somebody had been browsing in', () => {
    const { tabs } = withOwnDocumentTab();
    tabs.syncActive('/browse/Docs');
    const navigation = useTabNavigation();

    expect(navigation.closeOwn()).toBe(false);
    expect(tabs.count).toBe(2);
  });

  /** The last tab cannot close: there would be nowhere to be. */
  it('refuses the only tab', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    tabs.syncActive('/open/Docs/report.docx');
    tabs.activeTab.own = true;
    const navigation = useTabNavigation();

    expect(navigation.closeOwn()).toBe(false);
    expect(tabs.count).toBe(1);
  });

  /** With tabs off there is one tab and it is the window; closing is not ours. */
  it('refuses when tabs are turned off', () => {
    const { tabs } = withOwnDocumentTab();
    tabs.setEnabled(false);
    tabs.activeTab.own = true;
    const navigation = useTabNavigation();

    expect(navigation.closeOwn()).toBe(false);
  });

  /** Whatever is left takes over, and the address follows it. */
  it('goes where the tab that takes over says it is', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    tabs.syncActive('/browse/Photos');
    const second = tabs.open('/open/Docs/report.docx', { own: true });
    const navigation = useTabNavigation();

    expect(navigation.closeOwn()).toBe(true);
    expect(tabs.activeId).not.toBe(second.id);
    expect(push).toHaveBeenCalledWith('/browse/Photos');
  });
});

describe('a tab opened behind', () => {
  const openBehind = (path = '/open/Docs/report.docx') => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const navigation = useTabNavigation();
    const tab = navigation.open(path, { behind: true, own: true });
    return { tabs, tab };
  };

  /**
   * Waited for on the clock rather than on a turn of the microtask queue: what
   * the warming needs is fetched with dynamic imports, and a handful of
   * `Promise.resolve()` comes back while they are still loading.
   */
  const loaded = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** The reader is still looking at something else, which is when there is time. */
  it('is got ready, and the reader is left where they were', async () => {
    const { tab } = openBehind();
    await loaded();

    expect(warmTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ id: tab.id, kind: 'document' })],
      expect.anything()
    );
    expect(push).not.toHaveBeenCalled();
  });

  /** A tab opened in front is already being drawn: there is nothing to prepare. */
  it('is not got ready when it is opened in front', async () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    useTabNavigation().open('/open/Docs/report.docx', { own: true });
    await loaded();

    expect(warmTabs).not.toHaveBeenCalled();
  });

  it('is not got ready when this account has said not to', async () => {
    settings.userSettings = { preloadBackgroundTabs: false };
    openBehind();
    await loaded();

    expect(warmTabs).not.toHaveBeenCalled();
  });

  /**
   * Before the settings arrive the answer is not "no", it is *unknown* — and
   * acting on the wrong one here would open editing sessions nobody asked for.
   */
  it('is not got ready before the account has answered', async () => {
    settings.loaded = false;
    openBehind();
    await loaded();

    expect(warmTabs).not.toHaveBeenCalled();
  });

  it('is not got ready when the row was full and no tab was opened', async () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    tabs.setLimit(1);
    useTabNavigation().open('/open/Docs/report.docx', { behind: true });
    await loaded();

    expect(warmTabs).not.toHaveBeenCalled();
  });
});
