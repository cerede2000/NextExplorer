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

import { useTabNavigation } from './tabNavigation';
import { useTabsStore } from '@/stores/tabs';

beforeEach(() => {
  setActivePinia(createPinia());
  push.mockClear();
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
