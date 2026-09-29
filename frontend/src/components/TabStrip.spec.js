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
  duplicate: vi.fn(() => ({ id: 'copy' })),
  togglePinned: vi.fn(),
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
      duplicate: (...args) => store.duplicate(...args),
      togglePinned: (...args) => store.togglePinned(...args),
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
// A tab inside a favourite wears that favourite's icon: somebody who keeps four
// folders picked those icons to tell them apart at a glance.
const favorites = vi.hoisted(() => ({ favorites: [] }));
vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => favorites }));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => ({ userSettings }) }));
vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

/**
 * Dropping files onto a tab is the same gesture the favourites already take, so
 * what the strip owes is the destination, not the move: it says which folder the
 * tab is on and hands the drag to the one place that knows how to move files.
 * Standing in for it here also keeps the file store, and everything it imports,
 * out of a suite about a row of buttons.
 */
const fileDrag = vi.hoisted(() => ({
  handleDragOver: vi.fn(),
  handleDragLeave: vi.fn(),
  handleDrop: vi.fn(),
  isDragTarget: vi.fn(() => false),
  isCopyDragTarget: vi.fn(() => false),
}));
vi.mock('@/composables/useFileDragDrop', () => ({ useFileDragDrop: () => fileDrag }));

/**
 * Which tabs are still working, so the strip can say so where their icon goes.
 * Standing in for the store keeps this suite about a row of buttons — whether the
 * work is a listing, a file or a document server is the warming's business.
 */
const loading = vi.hoisted(() => ({ isLoading: vi.fn(() => false) }));
vi.mock('@/stores/tabLoading', () => ({ useTabLoadingStore: () => loading }));

import TabStrip from './TabStrip.vue';

const tab = (id, kind, path, extra = {}) => ({ id, kind, path, pinned: false, ...extra });

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
  favorites.favorites = [];
  Object.values(actions).forEach((fn) => fn.mockReset());
  Object.values(store).forEach((fn) => fn.mockReset());
  fileDrag.handleDragOver.mockClear();
  fileDrag.handleDragLeave.mockClear();
  fileDrag.handleDrop.mockClear();
  fileDrag.isDragTarget.mockReturnValue(false);
  fileDrag.isCopyDragTarget.mockReturnValue(false);
  loading.isLoading.mockReturnValue(false);
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

    await wrapper.get('[data-test="tab-close-others"]').trigger('click');

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

/**
 * A tab inside a favourite wears that favourite's icon.
 *
 * Somebody who keeps four folders as favourites picked those icons to tell them
 * apart at a glance, and a row of identical folder icons throws that away. It
 * lasts as long as the tab is in that folder — walk out and the tab is an
 * ordinary folder again, because the icon was never the tab's.
 */
describe('the icon a tab wears', () => {
  const iconOf = (wrapper) => wrapper.get('[role="tab"]').find('svg');
  // The browser writes a colour back as `rgb(...)`, whatever it was given.
  const colourOf = (wrapper) => iconOf(wrapper).attributes('style') || '';

  it('is the favourite own, for a tab on that folder', () => {
    favorites.favorites = [{ path: 'Media/Photos', icon: 'PhotoIcon', color: '#ff8800' }];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Media/Photos')]);

    expect(colourOf(wrapper)).toContain('255, 136, 0');
  });

  /** Inside it too: walking deeper is still being in that favourite. */
  it('stays on a folder inside it', () => {
    favorites.favorites = [{ path: 'Media/Photos', icon: 'PhotoIcon', color: '#ff8800' }];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Media/Photos/2026')]);

    expect(colourOf(wrapper)).toContain('255, 136, 0');
  });

  it('goes back to the folder icon once the tab is somewhere else', () => {
    favorites.favorites = [{ path: 'Media/Photos', icon: 'PhotoIcon', color: '#ff8800' }];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs')]);

    expect(colourOf(wrapper)).toBe('');
  });

  /** A name beginning the same way is not the same folder. */
  it('is not worn by a folder that merely starts with the same letters', () => {
    favorites.favorites = [{ path: 'Media/Photos', icon: 'PhotoIcon', color: '#ff8800' }];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Media/Photoshoots')]);

    expect(colourOf(wrapper)).toBe('');
  });

  /** The deepest answer to "where is this tab" wins. */
  it('is the innermost favourite when one is inside another', () => {
    favorites.favorites = [
      { path: 'Media', icon: 'FolderIcon', color: '#111111' },
      { path: 'Media/Photos', icon: 'PhotoIcon', color: '#ff8800' },
    ];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Media/Photos/2026')]);

    expect(colourOf(wrapper)).toContain('255, 136, 0');
  });

  /** An address with a space in it is stored encoded and matched decoded. */
  it('matches a folder whose name holds a space', () => {
    favorites.favorites = [{ path: 'Docs/data set', icon: 'PhotoIcon', color: '#00aa55' }];
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs/data%20set')]);

    expect(colourOf(wrapper)).toContain('0, 170, 85');
  });

  /** Only a folder: a document or the trash has an icon of its own kind. */
  it('is never worn by a tab that is not a folder', () => {
    favorites.favorites = [{ path: 'Media', icon: 'PhotoIcon', color: '#ff8800' }];
    const wrapper = withTabs([tab('a', 'document', '/open/Media/report.docx')]);

    expect(colourOf(wrapper)).toBe('');
  });
});

/**
 * A tab kept on purpose.
 *
 * It is there to be recognised rather than read, so it is its icon and nothing
 * else — which is also what gives the room back to the tabs that are being read.
 * And it has no cross: a folder somebody works in every day should not be one
 * mis-aimed click from being gone.
 */
describe('a pinned tab', () => {
  const withOnePinned = () =>
    withTabs([
      tab('a', 'folder', '/browse/Docs', { pinned: true }),
      tab('b', 'folder', '/browse/B'),
    ]);

  it('is its icon, with no name beside it', () => {
    const wrapper = withOnePinned();

    const [pinned, ordinary] = wrapper.findAll('[data-test="tab"]');
    expect(pinned.attributes('data-pinned')).toBe('true');
    expect(pinned.text()).toBe('');
    expect(ordinary.text()).toContain('B');
  });

  it('has no cross, while the tab beside it does', () => {
    const wrapper = withOnePinned();

    const [pinned, ordinary] = wrapper.findAll('[data-test="tab"]');
    expect(pinned.find('[data-test="tab-close"]').exists()).toBe(false);
    expect(ordinary.find('[data-test="tab-close"]').exists()).toBe(true);
  });

  it('is kept, and let go, from its own menu', async () => {
    const wrapper = withOnePinned();
    await wrapper.findAll('[role="tab"]')[1].trigger('contextmenu');

    await wrapper.get('[data-test="tab-pin"]').trigger('click');

    expect(store.togglePinned).toHaveBeenCalledWith('b');
    expect(wrapper.find('[data-test="tab-menu"]').exists()).toBe(false);
  });
});

describe('the same place again, beside itself', () => {
  it('is asked for from the tab’s own menu, and is brought forward', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);
    await wrapper.findAll('[role="tab"]')[0].trigger('contextmenu');

    await wrapper.get('[data-test="tab-duplicate"]').trigger('click');

    expect(store.duplicate).toHaveBeenCalledWith('a');
    expect(actions.activate).toHaveBeenCalledWith('copy');
  });

  it('is not offered when the row is full', async () => {
    state.atLimit.value = true;
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);
    await wrapper.findAll('[role="tab"]')[0].trigger('contextmenu');

    expect(wrapper.get('[data-test="tab-duplicate"]').attributes('disabled')).toBeDefined();
  });
});

/**
 * Files dropped onto a tab.
 *
 * A tab is a folder that is already open, which makes it the cheapest target
 * there is: no walking there, no second window, no losing the listing the files
 * came from. What the strip owes is the destination and the difference between
 * the two drags it can receive — its own tab being carried along the row, and
 * files arriving from a listing.
 */
describe('files dropped on a tab', () => {
  const dragEvent = () => ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { types: ['application/json'], dropEffect: 'move' },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10 }) },
    clientX: 5,
    clientY: 5,
  });

  it('are offered the folder the tab is on', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs/2026')]);

    await wrapper.get('[data-test="tab"]').trigger('dragover', dragEvent());

    expect(fileDrag.handleDragOver).toHaveBeenCalledWith(expect.anything(), {
      name: '2026',
      path: 'Docs',
      destinationPath: 'Docs/2026',
    });
  });

  it('are moved into it when they are let go', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs/2026')]);

    await wrapper.get('[data-test="tab"]').trigger('drop', dragEvent());

    expect(fileDrag.handleDrop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationPath: 'Docs/2026' })
    );
  });

  /** A document, the trash, the settings: none of them is a folder to drop into. */
  it('are not offered a tab that is not a folder', async () => {
    const wrapper = withTabs([tab('a', 'trash', '/trash')]);

    await wrapper.get('[data-test="tab"]').trigger('dragover', dragEvent());

    expect(fileDrag.handleDragOver).not.toHaveBeenCalled();
  });

  /** And the strip’s own drag is not a file arriving: it is a tab being carried. */
  it('are not confused with a tab being dragged along the row', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);
    const boxes = wrapper.findAll('[data-test="tab"]');

    await boxes[0].trigger('dragstart', { dataTransfer: { setData: vi.fn() } });
    await boxes[1].trigger('dragover', dragEvent());

    expect(fileDrag.handleDragOver).not.toHaveBeenCalled();
    expect(boxes[1].attributes('data-over')).toBe('true');
  });

  it('say which way they are going, so the tab can show it', () => {
    fileDrag.isDragTarget.mockReturnValue(true);
    fileDrag.isCopyDragTarget.mockReturnValue(true);
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs')]);

    expect(wrapper.get('[data-test="tab"]').attributes('data-drop')).toBe('copy');
  });
});

/**
 * A tab still working says so, where its icon goes.
 *
 * What a browser does, and it matters more here than there: a tab got ready in the
 * background is working while the reader is looking at something else, so without a
 * word from it there is nothing to tell "not there yet" from "there, and empty".
 */
describe('a tab that is still working', () => {
  it('shows a spinner in place of its icon', () => {
    loading.isLoading.mockImplementation((id) => id === 'b');
    const wrapper = withTabs([tab('a', 'folder', '/browse/A'), tab('b', 'folder', '/browse/B')]);

    const [quiet, busy] = wrapper.findAll('[data-test="tab"]');
    expect(busy.attributes('data-loading')).toBe('true');
    expect(busy.find('[data-test="tab-loading"]').exists()).toBe(true);
    expect(quiet.find('[data-test="tab-loading"]').exists()).toBe(false);
  });

  /**
   * The size it is told to be, and no larger.
   *
   * The first one was `LoadingIcon`, whose box is sized from `font-size: 48px` in a
   * global stylesheet — the `scale-50` that makes it look half that is a transform
   * and changes nothing about the room it takes. Forty-eight pixels tall in a row of
   * twenty-four: the strip grew and the whole page moved down.
   */
  it('is an icon the size of the one it replaces', () => {
    loading.isLoading.mockReturnValue(true);
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    const spinner = wrapper.get('[data-test="tab-loading"]');
    expect(spinner.element.tagName.toLowerCase()).toBe('svg');
    // Sized by the class it is given, like every other icon on a tab.
    expect(spinner.classes()).toContain('h-4');
    expect(spinner.classes()).toContain('w-4');
    // And nothing of its own to size it: a viewBox scales, an attribute does not.
    expect(spinner.attributes('width')).toBeUndefined();
    expect(spinner.attributes('height')).toBeUndefined();
  });

  /** In its place, so the name does not move sideways when the work ends. */
  it('still names the tab while it works', () => {
    loading.isLoading.mockReturnValue(true);
    const wrapper = withTabs([tab('a', 'folder', '/browse/Docs/2026')]);

    expect(wrapper.get('[data-test="tab"]').text()).toContain('2026');
  });

  it('shows its own icon again once the work is over', async () => {
    const wrapper = withTabs([tab('a', 'folder', '/browse/A')]);

    expect(wrapper.get('[data-test="tab"]').attributes('data-loading')).toBe('false');
    expect(wrapper.find('[data-test="tab-loading"]').exists()).toBe(false);
  });
});
