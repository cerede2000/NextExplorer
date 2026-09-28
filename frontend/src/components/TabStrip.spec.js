import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The strip of tabs.
 *
 * Two rules are worth holding, and both are about *not* drawing: the strip is
 * absent unless the account asked for tabs, and absent on an address no tab can
 * be on — signing in, a share's password — where it would offer to leave the
 * question unanswered. The rest is that each button does what it says.
 */

const state = {
  visible: ref(true),
  tabs: ref([]),
  activeId: ref(''),
  canClose: ref(true),
  atLimit: ref(false),
  limit: ref(10),
};
const actions = {
  activate: vi.fn(),
  open: vi.fn(),
  openHome: vi.fn(),
  close: vi.fn(),
  closeOthers: vi.fn(),
  closeAll: vi.fn(),
};

// The store's own reordering, as the strip reaches it. `canMove` answers from the
// list rather than always saying yes: whether the entry is greyed out at the ends
// of the row is part of what this component is being asked.
const store = {
  move: vi.fn(),
  nudge: vi.fn(),
};
const indexOf = (id) => state.tabs.value.findIndex((tab) => tab.id === id);

vi.mock('@/composables/tabNavigation', () => ({
  useTabNavigation: () => ({
    ...actions,
    visible: state.visible,
    tabs: {
      get tabs() {
        return state.tabs.value;
      },
      get activeId() {
        return state.activeId.value;
      },
      get canClose() {
        return state.canClose.value;
      },
      get atLimit() {
        return state.atLimit.value;
      },
      get limit() {
        return state.limit.value;
      },
      move: (...args) => store.move(...args),
      nudge: (...args) => store.nudge(...args),
      canMove: (id, step) => {
        const at = indexOf(id);
        return at >= 0 && at + step >= 0 && at + step < state.tabs.value.length;
      },
    },
  }),
}));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));
// Whether a double click closes a tab is an account's answer, and this spec is
// about the strip: what is asked here is that it obeys.
const userSettings = vi.hoisted(() => ({ closeTabsOnDoubleClick: false }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => ({ userSettings }) }));

import TabStrip from './TabStrip.vue';

const tab = (id, kind, path) => ({ id, kind, path });

const withTabs = (list, active = list[0]?.id) => {
  state.tabs.value = list;
  state.activeId.value = active;
  state.canClose.value = list.length > 1;
  return mount(TabStrip);
};

beforeEach(() => {
  state.visible.value = true;
  state.tabs.value = [];
  state.activeId.value = '';
  state.canClose.value = true;
  state.atLimit.value = false;
  state.limit.value = 10;
  userSettings.closeTabsOnDoubleClick = false;
  Object.values(actions).forEach((fn) => fn.mockReset());
  Object.values(store).forEach((fn) => fn.mockReset());
});

describe('when the strip is drawn at all', () => {
  it('is not, when there is nothing to draw it over', () => {
    state.visible.value = false;
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs')]);

    expect(wrapper.find('[data-test="tab-strip"]').exists()).toBe(false);
  });

  it('is, with one button per tab and the one in front marked', () => {
    const wrapper = withTabs(
      [tab('a', 'folder', '/browse/Docs'), tab('b', 'trash', '/trash')],
      'b'
    );

    const drawn = wrapper.findAll('[data-test="tab"]');
    expect(drawn).toHaveLength(2);
    expect(drawn[0].attributes('data-active')).toBe('false');
    expect(drawn[1].attributes('data-active')).toBe('true');
    expect(drawn[1].attributes('data-kind')).toBe('trash');
  });

  it('names a folder after the folder, and a named screen after itself', () => {
    const wrapper = withTabs([
      tab('a', 'folder', '/browse/Docs/2026'),
      tab('b', 'trash', '/trash'),
    ]);

    const drawn = wrapper.findAll('[data-test="tab"]');
    expect(drawn[0].text()).toContain('2026');
    expect(drawn[1].text()).toContain('trash.title');
  });
});

describe('what the buttons do', () => {
  it('brings a tab forward', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    await wrapper.findAll('[role="tab"]')[1].trigger('click');

    expect(actions.activate).toHaveBeenCalledWith('b');
  });

  it('closes one, from its cross and from the middle button', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    await wrapper.findAll('[data-test="tab-close"]')[1].trigger('click');
    expect(actions.close).toHaveBeenCalledWith('b');

    await wrapper.findAll('[role="tab"]')[0].trigger('auxclick', { button: 1 });
    expect(actions.close).toHaveBeenCalledWith('a');
  });

  /** There would be nowhere to be, so the cross is not offered. */
  it('offers no cross on the only tab', () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    expect(wrapper.find('[data-test="tab-close"]').exists()).toBe(false);
  });

  it('opens a new one', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    await wrapper.get('[data-test="tab-new"]').trigger('click');

    expect(actions.openHome).toHaveBeenCalledTimes(1);
  });
});

describe('the menu on a tab', () => {
  it('is not there until the tab is asked', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);
    expect(wrapper.find('[data-test="tab-menu"]').exists()).toBe(false);

    await wrapper.findAll('[role="tab"]')[1].trigger('contextmenu');

    expect(wrapper.findAll('[data-test="tab-menu"]')).toHaveLength(1);
  });

  it('closes the others, and shuts itself', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);
    await wrapper.findAll('[role="tab"]')[0].trigger('contextmenu');

    await wrapper.get('[data-test="tab-menu"]').findAll('button')[3].trigger('click');

    expect(actions.closeOthers).toHaveBeenCalledWith('a');
    expect(wrapper.find('[data-test="tab-menu"]').exists()).toBe(false);
  });
});

/**
 * Putting the tabs in the order the reader wants them.
 *
 * Two folders being compared belong side by side, whichever order they happened
 * to be opened in. Dragging is how every browser says this; the same move is in
 * the tab's own menu, which is the only way to say it from a touch screen, from
 * the keyboard, or with a trackpad somebody cannot drag with.
 */
describe('moving a tab along the row', () => {
  const three = () =>
    withTabs([
      tab('a', 'folder', '/browse/A'),
      tab('b', 'folder', '/browse/B'),
      tab('c', 'folder', '/browse/C'),
    ]);

  const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

  it('takes the place of the tab it is dropped on', async () => {
    const wrapper = three();
    const tabs = wrapper.findAll('[data-test="tab"]');

    await tabs[2].trigger('dragstart', { dataTransfer: transfer() });
    await tabs[0].trigger('dragover', { dataTransfer: transfer() });
    await tabs[0].trigger('drop');

    expect(store.move).toHaveBeenCalledWith('c', 0);
  });

  it('shows where it would land while it is held over a tab', async () => {
    const wrapper = three();
    const tabs = wrapper.findAll('[data-test="tab"]');

    await tabs[2].trigger('dragstart', { dataTransfer: transfer() });
    await tabs[0].trigger('dragover', { dataTransfer: transfer() });

    expect(tabs[0].attributes('data-over')).toBe('true');
    expect(tabs[1].attributes('data-over')).toBe('false');
  });

  it('is not dropped on itself', async () => {
    const wrapper = three();
    const tabs = wrapper.findAll('[data-test="tab"]');

    await tabs[1].trigger('dragstart', { dataTransfer: transfer() });
    await tabs[1].trigger('drop');

    expect(store.move).not.toHaveBeenCalled();
  });

  /** Nothing is being dragged, so nothing lands: a file dropped on the strip. */
  it('ignores a drop that started somewhere else', async () => {
    const wrapper = three();

    await wrapper.findAll('[data-test="tab"]')[0].trigger('drop');

    expect(store.move).not.toHaveBeenCalled();
  });

  it('moves one place at a time from the menu', async () => {
    const wrapper = three();
    await wrapper.findAll('[role="tab"]')[1].trigger('contextmenu');

    await wrapper.get('[data-test="tab-move-left"]').trigger('click');

    expect(store.nudge).toHaveBeenCalledWith('b', -1);
    // And the menu is gone, as it is after everything else it offers.
    expect(wrapper.find('[data-test="tab-menu"]').exists()).toBe(false);
  });

  it('offers the other direction too', async () => {
    const wrapper = three();
    await wrapper.findAll('[role="tab"]')[1].trigger('contextmenu');

    await wrapper.get('[data-test="tab-move-right"]').trigger('click');

    expect(store.nudge).toHaveBeenCalledWith('b', 1);
  });

  it('offers neither direction where there is nowhere to go', async () => {
    const wrapper = three();
    await wrapper.findAll('[role="tab"]')[0].trigger('contextmenu');

    expect(wrapper.get('[data-test="tab-move-left"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="tab-move-right"]').attributes('disabled')).toBeUndefined();
  });
});

/**
 * A row that never scrolls, and what happens when it is full.
 *
 * Past a certain number tabs are too narrow to read, and a strip that scrolls
 * hides the very tabs somebody opened — so the row stops instead, at a number an
 * administrator chooses. The "+" says why rather than doing nothing.
 */
describe('a row with no room left', () => {
  it('offers no new tab, and says why', () => {
    state.atLimit.value = true;
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    const plus = wrapper.get('[data-test="tab-new"]');
    expect(plus.attributes('disabled')).toBeDefined();
    expect(plus.attributes('title')).toBe('tabs.full');
  });

  it('offers one, named plainly, while there is room', () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    const plus = wrapper.get('[data-test="tab-new"]');
    expect(plus.attributes('disabled')).toBeUndefined();
    expect(plus.attributes('title')).toBe('tabs.newTab');
  });
});

/**
 * Closing all of them, which means starting again: a window with no tabs has
 * nowhere to be.
 */
describe('closing every tab', () => {
  it('is offered while there is more than one', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    await wrapper.get('[data-test="tab-close-all"]').trigger('click');

    expect(actions.closeAll).toHaveBeenCalled();
  });

  /** With one tab there is nothing to close: it would close and reopen itself. */
  it('is not offered for a single tab', () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    expect(wrapper.find('[data-test="tab-close-all"]').exists()).toBe(false);
  });
});

/**
 * Closing a tab by double-clicking it, which is an account's answer.
 *
 * Off by default: a double click is also how somebody with a trackpad ends up
 * clicking twice, and a tab closing under them would be a surprise nobody asked
 * for.
 */
describe('a double click on a tab', () => {
  it('closes it when that is what this account asked for', async () => {
    userSettings.closeTabsOnDoubleClick = true;
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    await wrapper.findAll('[role="tab"]')[1].trigger('dblclick');

    expect(actions.close).toHaveBeenCalledWith('b');
  });

  it('does nothing otherwise, which is what it did before', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    await wrapper.findAll('[role="tab"]')[1].trigger('dblclick');

    expect(actions.close).not.toHaveBeenCalled();
  });
});
