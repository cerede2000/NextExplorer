import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

/**
 * One of the panes a split view is made of.
 *
 * What is wrong by default here, and was the first time, is which tab a pane
 * thinks it is drawing: it asked the pane composable, and `inject` does not see
 * what the same component provided — so both panes answered "the tab in front"
 * and both said they had focus. Which is why every assertion below is about the
 * pane that does *not* hold the active tab; a pane that does cannot tell the
 * difference, and neither could the store.
 *
 * The other fault that pane had is not visible from here: a tab dropped into it
 * never arrived, because the uploader's drop target is the scrolling area inside
 * the pane and stops a drop before it can bubble out. There is no uploader in
 * jsdom, so that one is held by the browser journey, where it was found.
 */

const appTabs = vi.hoisted(() => ({
  tabs: [
    { id: 'tab-here', kind: 'folder', path: '/browse/Here' },
    { id: 'tab-beside', kind: 'folder', path: '/browse/Beside' },
  ],
  activeId: 'tab-here',
  activate: vi.fn(),
  showInPane: vi.fn(),
  closePane: vi.fn(),
}));
vi.mock('@/stores/tabs', () => ({ useTabsStore: () => appTabs }));

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush, resolve: () => ({ matched: [] }) }),
  useRoute: () => ({ params: {}, query: {}, path: '/browse/Here', fullPath: '/browse/Here' }),
  // Mocking a router means mocking what builds one: the module the application
  // keeps its routes in is pulled in by what a pane resolves.
  createRouter: () => ({ beforeEach: vi.fn(), afterEach: vi.fn(), resolve: vi.fn() }),
  createWebHistory: () => ({}),
  RouterLink: { template: '<a><slot /></a>' },
}));

// What a pane draws is a screen of its own; the breadcrumb reaches further than
// this component and is held in its own place.
vi.mock('@/components/BreadCrumb.vue', () => ({
  default: defineComponent({ setup: () => () => h('div', { class: 'breadcrumb' }) }),
}));

import TabPane from './TabPane.vue';
import { TAB_DRAG_TYPE } from '@/utils/tabDrag';

const Drawn = defineComponent({
  setup: () => () => h('div', { 'data-test': 'drawn' }, 'a screen'),
});

const paneFor = (tabId, extra = {}) =>
  mount(TabPane, {
    props: { tabId, routedComponent: Drawn, routedKey: '/browse/Here', ...extra },
    global: { mocks: { $t: (key) => key } },
  });

/** A drag carrying a tab, as the strip starts one. */
const tabDrag = (id) => ({
  preventDefault: vi.fn(),
  currentTarget: null,
  relatedTarget: null,
  dataTransfer: {
    types: ['text/plain', TAB_DRAG_TYPE],
    getData: (type) => (type === TAB_DRAG_TYPE ? id : ''),
  },
});

beforeEach(() => {
  appTabs.activeId = 'tab-here';
  appTabs.activate.mockReset();
  appTabs.showInPane.mockReset();
  appTabs.closePane.mockReset();
  routerPush.mockReset();
});

describe('a pane', () => {
  it('has focus only when it holds the tab in front', () => {
    expect(paneFor('tab-here').attributes('data-focused')).toBe('true');
    expect(paneFor('tab-beside').attributes('data-focused')).toBe('false');
  });

  it('says which tab it is drawing, so the screens inside it can ask', () => {
    expect(paneFor('tab-beside').attributes('data-pane-tab')).toBe('tab-beside');
  });

  /**
   * The router's own component is for the pane the reader is in: that pane keeps
   * every route guard and the address bar. The other is on an address the router
   * is not, so it resolves its own.
   */
  it('draws the router’s screen while it is the pane in front', () => {
    expect(paneFor('tab-here').find('[data-test="drawn"]').exists()).toBe(true);
    expect(paneFor('tab-beside').find('[data-test="drawn"]').exists()).toBe(false);
  });

  it('puts the reader in it when pressed, and takes the address with it', async () => {
    const pane = paneFor('tab-beside');

    await pane.trigger('pointerdown');

    expect(appTabs.activate).toHaveBeenCalledWith('tab-beside');
    expect(routerPush).toHaveBeenCalledWith('/browse/Beside');
  });

  it('does not move the reader when they are already in it', async () => {
    const pane = paneFor('tab-here');

    await pane.trigger('pointerdown');

    expect(appTabs.activate).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  /** Only when there are two of them: one pane has nothing to add to say where it is. */
  it('says where it is only while it sits beside another', () => {
    expect(paneFor('tab-here').find('[data-test="pane-header"]').exists()).toBe(false);
    expect(paneFor('tab-here', { split: true }).find('[data-test="pane-header"]').exists()).toBe(
      true
    );
  });

  it('closes its own side, not whichever pane has focus', async () => {
    const pane = paneFor('tab-beside', { split: true, side: 'right' });

    await pane.find('[data-test="pane-close"]').trigger('click');

    expect(appTabs.closePane).toHaveBeenCalledWith('right');
  });
});

describe('a tab dropped into a pane', () => {
  it('goes into the pane it was dropped on', () => {
    const pane = paneFor('tab-here', { split: true, side: 'right' });

    // Through the element rather than by reaching for the handler. Which phase
    // it listens in is not observable here — there is no uploader in jsdom to
    // swallow the drop — so that part is held by the browser journey, where it
    // was found.
    pane.element.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: tabDrag('tab-beside').dataTransfer,
      })
    );

    expect(appTabs.showInPane).toHaveBeenCalledWith('right', 'tab-beside');
  });

  /** A file drag falls straight through, so nothing below loses a drop it wanted. */
  it('leaves a drag that is not a tab alone', () => {
    const pane = paneFor('tab-here', { split: true, side: 'right' });

    pane.element.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: { types: ['Files'], getData: () => '' },
      })
    );

    expect(appTabs.showInPane).not.toHaveBeenCalled();
  });
});
