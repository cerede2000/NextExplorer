import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { createI18n } from 'vue-i18n';

/**
 * The folder, and everything it decides.
 *
 * 1200 lines wired to seven stores, eight composables and the scroll position
 * of a window that does not exist in a test runner — which is why it sat at two
 * per cent while everything around it was covered. Most of it is not layout
 * though: it is which item the arrow keys land on, whether a folder somebody
 * came back to opens where they left it, and whether the tab quietly re-reads
 * the listing behind their back.
 *
 * The stores are replaced by plain reactive objects so a test can state the
 * situation instead of assembling it, and the composables that reach further
 * (navigation, actions, drag and drop) are replaced by spies. What is exercised
 * is this file.
 */

/**
 * Reactive stand-ins for the stores and the route.
 *
 * Built inside the mock factories rather than beside them: a `vi.hoisted` block
 * runs before any import, so `reactive` does not exist yet there.
 */
const shared = vi.hoisted(() => {
  const objects = {};
  const make = async (name, initial = {}) => {
    const { reactive } = await import('vue');
    objects[name] ||= reactive(initial);
    return objects[name];
  };
  return { objects, make, routeLeaveGuards: [] };
});

const routeState = () => shared.objects.route;
const routeLeaveGuards = shared.routeLeaveGuards;
const stores = shared.objects;

vi.mock('vue-router', async () => {
  const route = await shared.make('route', { params: { path: 'Docs' }, query: {} });
  return {
    useRoute: () => route,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    onBeforeRouteLeave: (guard) => shared.routeLeaveGuards.push(guard),
    RouterLink: { template: '<a><slot /></a>' },
  };
});

vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

vi.mock('@/stores/settings', async () => {
  const store = await shared.make('settings');
  return { useSettingsStore: () => store };
});
vi.mock('@/stores/fileStore', async () => {
  const store = await shared.make('file');
  return { useFileStore: () => store };
});
vi.mock('@/stores/folderSize', async () => {
  const store = await shared.make('folderSize');
  return { useFolderSizeStore: () => store };
});
vi.mock('@/stores/volumeUsage', async () => {
  const store = await shared.make('volumeUsage');
  return { useVolumeUsageStore: () => store };
});
vi.mock('@/stores/features', async () => {
  const store = await shared.make('features');
  return { useFeaturesStore: () => store };
});
vi.mock('@/stores/folderScroll', async () => {
  const store = await shared.make('folderScroll');
  return { useFolderScrollStore: () => store };
});
vi.mock('@/stores/operationTasks', async () => {
  const store = await shared.make('operationTasks');
  return { useOperationTasksStore: () => store };
});

const composables = vi.hoisted(() => ({
  clearSelection: vi.fn(),
  toggleSelection: vi.fn(),
  openBackgroundMenu: vi.fn(),
  openItem: vi.fn(),
  goNext: vi.fn(),
  goPrev: vi.fn(),
  goUp: vi.fn(),
  isEditableElement: vi.fn(() => false),
  handleDragOver: vi.fn(),
  handleDragLeave: vi.fn(),
  handleDrop: vi.fn(),
  isDeleteConfirmOpen: null,
}));

vi.mock('@/composables/itemSelection', () => ({
  useSelection: () => ({
    clearSelection: composables.clearSelection,
    toggleSelection: composables.toggleSelection,
  }),
}));
vi.mock('@/composables/contextMenu', () => ({
  useExplorerContextMenu: () => ({ openBackgroundMenu: composables.openBackgroundMenu }),
}));
vi.mock('@/composables/navigation', () => ({
  useNavigation: () => ({
    openItem: composables.openItem,
    goNext: composables.goNext,
    goPrev: composables.goPrev,
    goUp: composables.goUp,
  }),
}));
vi.mock('@/composables/fileActions', () => ({
  useFileActions: () => ({ isEditableElement: composables.isEditableElement }),
}));
vi.mock('@/composables/useDeleteConfirm', () => ({
  useDeleteConfirm: () => ({ isDeleteConfirmOpen: composables.isDeleteConfirmOpen }),
}));
vi.mock('@/composables/useFileDragDrop', () => ({
  useFileDragDrop: () => ({
    handleDragOver: composables.handleDragOver,
    handleDragLeave: composables.handleDragLeave,
    handleDrop: composables.handleDrop,
    isDragTarget: () => false,
    isCopyDragTarget: () => false,
  }),
}));
vi.mock('@/composables/fileUploader', () => ({ useUppyDropTarget: () => {} }));
vi.mock('@/composables/useInputMode', () => ({ useInputMode: () => ({ isTouchDevice: false }) }));
vi.mock('@/composables/useViewConfig', async () => {
  const { computed } = await import('vue');
  return {
    useViewConfig: () => ({ gridClasses: computed(() => ''), gridStyle: computed(() => ({})) }),
  };
});
vi.mock('@coleqiu/vue-drag-select', () => ({
  DragSelect: { name: 'DragSelect', template: '<div><slot /></div>' },
}));

const FolderView = (await import('./FolderView.vue')).default;

const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false });

const file = (name, extra = {}) => ({ name, path: 'Docs', kind: 'file', ...extra });
const folder = (name, extra = {}) => file(name, { kind: 'directory', ...extra });

let wrapper = null;

const mountFolder = async () => {
  wrapper = mount(FolderView, {
    global: {
      plugins: [i18n],
      stubs: {
        FileObject: { template: '<div />' },
        LoadingIcon: true,
      },
    },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper.vm;
};

/** What the keyboard sees, without a real window to scroll. */
const press = async (key, modifiers = {}) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
  await flushPromises();
};

const selectedNames = () => stores.file.selectedItems.map((item) => item.name);

/**
 * jsdom has no `scrollIntoView`, and the view reads its presence as "this row
 * can be brought into sight". Without it the reveal path reports failure and
 * the remembered position quietly takes over — the opposite of what a browser
 * does. Local to this file: a no-op stub is not something every other spec
 * should silently inherit.
 */
let scrollIntoView = null;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  routeLeaveGuards.length = 0;
  Object.assign(routeState(), { params: { path: 'Docs' }, query: {} });

  Object.assign(composables, {
    isDeleteConfirmOpen: ref(false),
  });
  composables.clearSelection.mockClear();
  composables.toggleSelection.mockClear();
  composables.openItem.mockClear();
  composables.goNext.mockClear();
  composables.goPrev.mockClear();
  composables.goUp.mockClear();
  composables.openBackgroundMenu.mockClear();
  composables.isEditableElement.mockReturnValue(false);

  Object.assign(
    stores.settings,
    ({
      view: 'list',
      sortBy: { by: 'name', order: 'asc' },
      setSort: vi.fn((by, order) => {
        stores.settings.sortBy = { by, order };
      }),
      listViewColumnWidths: [0, 200, 100, 100, 160],
      setListViewColumnWidth: vi.fn(),
    })
  );

  Object.assign(
    stores.file,
    ({
      currentPath: 'Docs',
      currentPathData: null,
      renameState: null,
      items: [],
      selectedItems: [],
      fetchPathItems: vi.fn(async () => {}),
      prefetchItemThumbnail: vi.fn(async () => true),
      setKeyboardActionItem: vi.fn(),
      clearKeyboardActionItem: vi.fn(),
    })
  );

  // Real getters, so the view sees the listing change the way the store makes
  // it change. Object.assign would have copied one evaluation and frozen it.
  Object.defineProperty(stores.file, 'getCurrentPathItems', {
    configurable: true,
    get: () => stores.file.items,
  });
  Object.defineProperty(stores.file, 'selectedItemKeys', {
    configurable: true,
    get: () =>
      new Set(stores.file.selectedItems.map((item) => `${item.path || ''}::${item.name}`)),
  });

  Object.assign(stores.folderSize, {
    ensureSizes: vi.fn(async () => {}),
    scheduleRefresh: vi.fn(),
  });
  Object.assign(stores.volumeUsage, { scheduleRefresh: vi.fn() });
  Object.assign(stores.features, { folderSizeEnabled: true, volumeUsageEnabled: true });
  Object.assign(stores.folderScroll, {
    remember: vi.fn(),
    rememberActiveItem: vi.fn(),
    consumeRestoreState: vi.fn(() => ({ permitted: false, scrollTop: 0, activeItemKey: '' })),
  });
  Object.assign(stores.operationTasks, { operationCount: 0 });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  delete Element.prototype.scrollIntoView;
});

describe('opening a folder', () => {
  it('reads the folder the route names', async () => {
    await mountFolder();

    expect(stores.file.fetchPathItems).toHaveBeenCalledWith('Docs');
  });

  it('stops showing itself as loading once the listing is in', async () => {
    const view = await mountFolder();

    expect(view.loading).toBe(false);
  });

  /** A folder that will not load is still a folder somebody is looking at. */
  it('stops loading even when the listing never arrives', async () => {
    stores.file.fetchPathItems.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const view = await mountFolder();

    expect(view.loading).toBe(false);
  });
});

describe('the item a search result asked us to land on', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), file('report.pdf'), file('z.txt')];
  });

  it('is selected on arrival', async () => {
    routeState().query = { select: 'report.pdf' };

    await mountFolder();

    expect(selectedNames()).toEqual(['report.pdf']);
  });

  /** So the arrow keys carry on from there rather than from the top. */
  it('becomes where the keyboard is', async () => {
    routeState().query = { select: 'report.pdf' };

    const view = await mountFolder();

    expect(view.keyboardActiveItemKey).toBe('Docs::report.pdf');
    expect(stores.file.setKeyboardActionItem).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'report.pdf' })
    );
  });

  it('is ignored when the folder does not hold it', async () => {
    routeState().query = { select: 'gone.txt' };

    await mountFolder();

    expect(selectedNames()).toEqual([]);
  });

  /**
   * Landing on a named item is what the reader just asked for; the remembered
   * position is where they happened to be some time ago.
   */
  it('wins over the position this folder was left at', async () => {
    routeState().query = { select: 'report.pdf' };
    stores.folderScroll.consumeRestoreState.mockReturnValue({
      permitted: true,
      scrollTop: 900,
      activeItemKey: 'Docs::z.txt',
    });

    const view = await mountFolder();

    expect(view.keyboardActiveItemKey).toBe('Docs::report.pdf');
  });
});

describe('coming back to a folder', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), file('b.txt'), file('c.txt')];
  });

  it('puts the keyboard back on the item it was left on', async () => {
    stores.folderScroll.consumeRestoreState.mockReturnValue({
      permitted: true,
      scrollTop: 0,
      activeItemKey: 'Docs::b.txt',
    });

    const view = await mountFolder();

    expect(view.keyboardActiveItemKey).toBe('Docs::b.txt');
    expect(selectedNames()).toEqual(['b.txt']);
  });

  it('ignores a remembered item the folder no longer holds', async () => {
    stores.folderScroll.consumeRestoreState.mockReturnValue({
      permitted: true,
      scrollTop: 0,
      activeItemKey: 'Docs::deleted.txt',
    });

    const view = await mountFolder();

    expect(view.keyboardActiveItemKey).toBe('');
  });

  it('restores nothing when the store says this arrival is not a return', async () => {
    stores.folderScroll.consumeRestoreState.mockReturnValue({
      permitted: false,
      scrollTop: 400,
      activeItemKey: 'Docs::b.txt',
    });

    const view = await mountFolder();

    expect(view.keyboardActiveItemKey).toBe('');
  });

  /**
   * The keyed router view unmounts this component on a folder change, but the
   * guard runs first — before a view transition can reset the scroll container.
   */
  it('writes down where it was before the route moves on', async () => {
    await mountFolder();
    stores.folderScroll.remember.mockClear();

    routeLeaveGuards.forEach((guard) => guard());

    expect(stores.folderScroll.remember).toHaveBeenCalledWith('Docs::list', expect.any(Number));
  });

  it('writes it down on the way out too', async () => {
    await mountFolder();
    stores.folderScroll.remember.mockClear();

    wrapper.unmount();
    wrapper = null;

    expect(stores.folderScroll.remember).toHaveBeenCalled();
  });
});

describe('what an empty folder says', () => {
  it('says it is empty once it is known to be', async () => {
    const view = await mountFolder();

    expect(view.showEmptyFolderMessage).toBe(true);
  });

  /** Before the listing arrives, empty is not yet an answer. */
  it('says nothing while it is still loading', async () => {
    stores.file.fetchPathItems.mockImplementationOnce(() => new Promise(() => {}));
    wrapper = mount(FolderView, {
      global: { plugins: [i18n], stubs: { FileObject: { template: '<div />' }, LoadingIcon: true } },
    });

    expect(wrapper.vm.showEmptyFolderMessage).toBe(false);
  });

  it('says a folder of documents holds no photos, in the photo view', async () => {
    stores.settings.view = 'photos';
    stores.file.items = [file('notes.txt'), file('sheet.csv')];

    const view = await mountFolder();

    expect(view.showNoPhotosMessage).toBe(true);
  });

  it('says nothing of the sort when one of them is an image', async () => {
    stores.settings.view = 'photos';
    stores.file.items = [file('notes.txt'), file('holiday.jpg', { kind: 'jpg' })];

    const view = await mountFolder();

    expect(view.showNoPhotosMessage).toBe(false);
  });

  /** Before the listing arrives, "no photos here" is a guess, not an answer. */
  it('says nothing about photos while it is still loading', async () => {
    stores.settings.view = 'photos';
    stores.file.items = [file('notes.txt')];
    stores.file.fetchPathItems.mockImplementationOnce(() => new Promise(() => {}));
    wrapper = mount(FolderView, {
      global: { plugins: [i18n], stubs: { FileObject: { template: '<div />' }, LoadingIcon: true } },
    });

    expect(wrapper.vm.showNoPhotosMessage).toBe(false);
  });

  it('says nothing of the sort in any other view', async () => {
    stores.settings.view = 'list';
    stores.file.items = [file('notes.txt')];

    const view = await mountFolder();

    expect(view.showNoPhotosMessage).toBe(false);
  });
});

describe('sorting the list', () => {
  it('turns the order around when the same column is asked for again', async () => {
    stores.settings.sortBy = { by: 'name', order: 'asc' };
    const view = await mountFolder();

    view.toggleSort('name');

    expect(stores.settings.setSort).toHaveBeenCalledWith('name', 'desc');
  });

  /** Newest first, biggest first: the useful end of a date or a size. */
  it('starts a new column at the end that column is usually read from', async () => {
    stores.settings.sortBy = { by: 'name', order: 'asc' };
    const view = await mountFolder();

    view.toggleSort('size', 'desc');

    expect(stores.settings.setSort).toHaveBeenCalledWith('size', 'desc');
  });

  it('marks only the column actually sorted on', async () => {
    stores.settings.sortBy = { by: 'size', order: 'desc' };
    const view = await mountFolder();

    expect(view.sortIndicator('size')).toBe('desc');
    expect(view.sortIndicator('name')).toBeNull();
  });
});

describe('selecting everything', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), file('b.txt')];
  });

  it('selects every item when none of them were', async () => {
    const view = await mountFolder();

    view.toggleSelectAll();

    expect(selectedNames()).toEqual(['a.txt', 'b.txt']);
  });

  it('clears the selection when they all were', async () => {
    stores.file.selectedItems = [...stores.file.items];
    const view = await mountFolder();

    view.toggleSelectAll();

    expect(composables.clearSelection).toHaveBeenCalled();
  });

  it('knows when only some of them are', async () => {
    stores.file.selectedItems = [stores.file.items[0]];
    const view = await mountFolder();

    expect(view.someItemsSelected).toBe(true);
    expect(view.allItemsSelected).toBe(false);
  });

  it('calls an empty folder neither all nor partly selected', async () => {
    stores.file.items = [];
    const view = await mountFolder();

    expect(view.someItemsSelected).toBe(false);
    expect(view.allItemsSelected).toBe(false);
  });
});

describe('walking the folder with the arrow keys', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), file('b.txt'), folder('sub')];
  });

  it('starts at the first item', async () => {
    const view = await mountFolder();

    await press('ArrowDown');

    expect(view.keyboardActiveItemKey).toBe('Docs::a.txt');
  });

  it('carries on from where it is', async () => {
    const view = await mountFolder();

    await press('ArrowDown');
    await press('ArrowDown');

    expect(view.keyboardActiveItemKey).toBe('Docs::b.txt');
  });

  it('goes back up again', async () => {
    const view = await mountFolder();
    await press('ArrowDown');
    await press('ArrowDown');

    await press('ArrowUp');

    expect(view.keyboardActiveItemKey).toBe('Docs::a.txt');
  });

  /**
   * Moving the ring is not selecting: somebody arrowing through a folder to
   * find something has not asked to act on everything they passed.
   */
  it('moves the ring without selecting anything', async () => {
    await mountFolder();

    await press('ArrowDown');

    expect(selectedNames()).toEqual([]);
    expect(stores.file.setKeyboardActionItem).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a.txt' })
    );
  });

  it('selects a run of items when the shift key is held', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press('ArrowDown', { shiftKey: true });

    expect(selectedNames()).toEqual(['a.txt', 'b.txt']);
  });

  it('grows that run rather than starting a new one', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press('ArrowDown', { shiftKey: true });
    await press('ArrowDown', { shiftKey: true });

    expect(selectedNames()).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('shrinks it again on the way back', async () => {
    await mountFolder();
    await press('ArrowDown');
    await press('ArrowDown', { shiftKey: true });
    await press('ArrowDown', { shiftKey: true });

    await press('ArrowUp', { shiftKey: true });

    expect(selectedNames()).toEqual(['a.txt', 'b.txt']);
  });

  it('adds the item under the ring to the selection on the space bar', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press(' ');

    expect(composables.toggleSelection).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a.txt' })
    );
  });

  it('does nothing in an empty folder', async () => {
    stores.file.items = [];
    const view = await mountFolder();

    await press('ArrowDown');
    await press(' ');

    expect(view.keyboardActiveItemKey).toBe('');
  });
});

describe('opening and leaving with the keyboard', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), folder('sub')];
  });

  it('opens what the ring is on', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press('Enter');

    expect(composables.openItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.txt' }));
  });

  it('opens the one thing that is selected when the ring is nowhere', async () => {
    stores.file.selectedItems = [stores.file.items[1]];
    await mountFolder();

    await press('Enter');

    expect(composables.openItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'sub' }));
  });

  /** With several selected, the last one touched is the one Enter means. */
  it('opens the last of several selected things', async () => {
    stores.file.selectedItems = [...stores.file.items];
    await mountFolder();

    await press('Enter');

    expect(composables.openItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'sub' }));
  });

  it('opens nothing at all when nothing is selected and the ring is nowhere', async () => {
    await mountFolder();

    await press('Enter');

    expect(composables.openItem).not.toHaveBeenCalled();
  });

  /** Right enters a folder, the way a tree does; on a file it means nothing. */
  it('enters a folder on the right arrow', async () => {
    await mountFolder();
    await press('ArrowDown');
    await press('ArrowDown');

    await press('ArrowRight');

    expect(composables.openItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'sub' }));
  });

  /** Right on a file has nothing to enter, so it does nothing. */
  it('does not open a file on the right arrow', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press('ArrowRight');

    expect(composables.openItem).not.toHaveBeenCalled();
  });

  it('leaves the folder on the left arrow', async () => {
    await mountFolder();
    await press('ArrowDown');

    await press('ArrowLeft');

    expect(composables.goUp).toHaveBeenCalled();
  });

  it('goes up on backspace', async () => {
    await mountFolder();

    await press('Backspace');

    expect(composables.goUp).toHaveBeenCalled();
  });

  it('walks the history with the alt key', async () => {
    await mountFolder();

    await press('ArrowLeft', { altKey: true });
    await press('ArrowRight', { altKey: true });
    await press('ArrowUp', { altKey: true });

    expect(composables.goPrev).toHaveBeenCalled();
    expect(composables.goNext).toHaveBeenCalled();
    expect(composables.goUp).toHaveBeenCalled();
  });
});

describe('typing a name to jump to it', () => {
  beforeEach(() => {
    stores.file.items = [file('apple.txt'), file('banana.txt'), file('blueberry.txt')];
  });

  it('lands on the first item that starts with what was typed', async () => {
    await mountFolder();

    await press('b');

    expect(selectedNames()).toEqual(['banana.txt']);
  });

  it('narrows as more letters arrive', async () => {
    await mountFolder();

    await press('b');
    await press('l');

    expect(selectedNames()).toEqual(['blueberry.txt']);
  });

  it('ignores a letter typed with a modifier, which is a shortcut', async () => {
    await mountFolder();

    await press('b', { ctrlKey: true });

    expect(selectedNames()).toEqual([]);
  });

  it('says nothing about a folder holding no such name', async () => {
    await mountFolder();

    await press('z');

    expect(selectedNames()).toEqual([]);
  });
});

describe('when the keyboard belongs to something else', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt'), file('b.txt')];
  });

  it('leaves the folder alone while a name is being edited', async () => {
    const view = await mountFolder();
    stores.file.renameState = { name: 'a.txt' };

    await press('ArrowDown');

    expect(view.keyboardActiveItemKey).toBe('');
  });

  it('leaves it alone while a deletion is being confirmed', async () => {
    const view = await mountFolder();
    composables.isDeleteConfirmOpen.value = true;

    await press('ArrowDown');

    expect(view.keyboardActiveItemKey).toBe('');
  });

  it('leaves it alone while somebody is typing in a field', async () => {
    const view = await mountFolder();
    composables.isEditableElement.mockReturnValue(true);

    await press('ArrowDown');

    expect(view.keyboardActiveItemKey).toBe('');
  });

  it('leaves it alone when something else already answered the key', async () => {
    const view = await mountFolder();

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    await flushPromises();

    expect(view.keyboardActiveItemKey).toBe('');
  });
});

describe('fetching thumbnails while nothing else is happening', () => {
  const thumbnailable = (name) => file(name, { supportsThumbnail: true });

  /** Mounted, then the clock taken over, so only what a test asks for fires. */
  const withFakeClock = async (items) => {
    stores.file.items = items;
    const view = await mountFolder();
    vi.useFakeTimers();
    return view;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for one that could have a thumbnail and has none yet', async () => {
    const view = await withFakeClock([thumbnailable('photo.jpg')]);

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(stores.file.prefetchItemThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'photo.jpg' })
    );
  });

  it('passes over folders, and files that cannot have one', async () => {
    const view = await withFakeClock([folder('sub'), file('notes.txt')]);

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });

  it('passes over one the server already said it has no thumbnail for', async () => {
    const view = await withFakeClock([
      file('broken.jpg', { supportsThumbnail: true, thumbnailUnavailable: true }),
    ]);

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });

  it('works down the list rather than asking for the same one again', async () => {
    const view = await withFakeClock([thumbnailable('one.jpg'), thumbnailable('two.jpg')]);

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(3000);

    expect(stores.file.prefetchItemThumbnail.mock.calls.map(([item]) => item.name)).toEqual([
      'one.jpg',
      'two.jpg',
    ]);
  });

  /** Idle work waits: a copy or a move is what the person is actually waiting on. */
  it('holds off while a file operation is running', async () => {
    const view = await withFakeClock([thumbnailable('photo.jpg')]);
    stores.operationTasks.operationCount = 1;

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });

  it('stops the moment one starts', async () => {
    const view = await withFakeClock([thumbnailable('photo.jpg')]);
    view.scheduleIdleThumbnailPrefetch(50);

    stores.operationTasks.operationCount = 1;
    await vi.advanceTimersByTimeAsync(100);

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });

  /**
   * Idle work has an end: past a couple of dozen the reader has moved on, and
   * a thousand-file folder would otherwise fetch all night.
   */
  it('stops after a couple of dozen', async () => {
    const view = await withFakeClock(
      Array.from({ length: 40 }, (_, index) => thumbnailable(`photo${index}.jpg`))
    );

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(200000);

    expect(stores.file.prefetchItemThumbnail).toHaveBeenCalledTimes(24);
  });

  it('holds off while the tab is out of sight', async () => {
    const view = await withFakeClock([thumbnailable('photo.jpg')]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });

    view.scheduleIdleThumbnailPrefetch(0);
    await vi.advanceTimersByTimeAsync(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });

  /** Even one already waiting: the tab can go away between the two moments. */
  it('drops the one it had queued when the tab goes away first', async () => {
    const view = await withFakeClock([thumbnailable('photo.jpg')]);
    view.scheduleIdleThumbnailPrefetch(50);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await vi.advanceTimersByTimeAsync(100);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });

    expect(stores.file.prefetchItemThumbnail).not.toHaveBeenCalled();
  });
});

describe('the size of the folders on screen', () => {
  beforeEach(() => {
    stores.file.items = [folder('Photos'), file('notes.txt'), folder('Music')];
  });

  it('is asked for in one request, for the folders only', async () => {
    await mountFolder();

    expect(stores.folderSize.ensureSizes).toHaveBeenCalledWith(['Docs/Photos', 'Docs/Music']);
  });

  it('is not asked for at all when the feature is off', async () => {
    stores.features.folderSizeEnabled = false;

    await mountFolder();

    expect(stores.folderSize.ensureSizes).not.toHaveBeenCalled();
  });

  it('is not asked for in a folder holding no folders', async () => {
    stores.file.items = [file('notes.txt')];

    await mountFolder();

    expect(stores.folderSize.ensureSizes).not.toHaveBeenCalled();
  });

  /**
   * Serving the listing also asks the server to re-check these folders in the
   * background, so one follow-up surfaces what that found.
   */
  it('is asked for again shortly after, once the server has caught up', async () => {
    await mountFolder();
    vi.useFakeTimers();
    // The clock is taken over first, then the listing changes, so the
    // follow-up this schedules is one the test can advance to.
    stores.file.items = [folder('Photos')];
    await vi.advanceTimersByTimeAsync(0);
    stores.folderSize.scheduleRefresh.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(stores.folderSize.scheduleRefresh).toHaveBeenCalled();
  });
});

describe('coming back to the tab', () => {
  beforeEach(() => {
    stores.file.items = [file('a.txt')];
  });

  const returnToTab = async () => {
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
  };

  it('re-reads the listing, in case somebody else changed it', async () => {
    await mountFolder();
    stores.file.fetchPathItems.mockClear();

    await returnToTab();

    expect(stores.file.fetchPathItems).toHaveBeenCalledWith('Docs');
  });

  it('re-reads what the volume and the folders now weigh', async () => {
    await mountFolder();
    stores.folderSize.scheduleRefresh.mockClear();
    stores.volumeUsage.scheduleRefresh.mockClear();

    await returnToTab();

    expect(stores.folderSize.scheduleRefresh).toHaveBeenCalled();
    expect(stores.volumeUsage.scheduleRefresh).toHaveBeenCalled();
  });

  it('leaves each of those to the feature that owns it', async () => {
    stores.features.folderSizeEnabled = false;
    stores.features.volumeUsageEnabled = false;
    await mountFolder();
    stores.folderSize.scheduleRefresh.mockClear();
    stores.volumeUsage.scheduleRefresh.mockClear();

    await returnToTab();

    expect(stores.folderSize.scheduleRefresh).not.toHaveBeenCalled();
    expect(stores.volumeUsage.scheduleRefresh).not.toHaveBeenCalled();
  });

  /** Two windows regaining focus in the same second are one return. */
  it('does not re-read the listing twice in a moment', async () => {
    await mountFolder();
    stores.file.fetchPathItems.mockClear();

    await returnToTab();
    await returnToTab();

    expect(stores.file.fetchPathItems).toHaveBeenCalledTimes(1);
  });

  it('does not re-read it while the tab is still out of sight', async () => {
    await mountFolder();
    stores.file.fetchPathItems.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });

    await returnToTab();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });

    expect(stores.file.fetchPathItems).not.toHaveBeenCalled();
  });
});

describe('dragging the column edges in the detail view', () => {
  const drag = async (view, columnIndex, from, to) => {
    view.startResize(columnIndex, { button: 0, clientX: from });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
    await flushPromises();
  };

  it('widens the column by however far the pointer went', async () => {
    const view = await mountFolder();

    await drag(view, 1, 100, 160);

    expect(stores.settings.setListViewColumnWidth).toHaveBeenCalledWith(1, 260);
  });

  it('narrows it going the other way', async () => {
    const view = await mountFolder();

    await drag(view, 1, 100, 60);

    expect(stores.settings.setListViewColumnWidth).toHaveBeenCalledWith(1, 160);
  });

  it('stops when the pointer is let go', async () => {
    const view = await mountFolder();
    await drag(view, 1, 100, 160);
    stores.settings.setListViewColumnWidth.mockClear();

    window.dispatchEvent(new MouseEvent('pointerup'));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }));
    await flushPromises();

    expect(stores.settings.setListViewColumnWidth).not.toHaveBeenCalled();
  });

  it('ignores anything but the left button', async () => {
    const view = await mountFolder();

    view.startResize(1, { button: 2, clientX: 100 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }));
    await flushPromises();

    expect(stores.settings.setListViewColumnWidth).not.toHaveBeenCalled();
  });

  it('ignores a column with no width to start from', async () => {
    stores.settings.listViewColumnWidths = [];
    const view = await mountFolder();

    await drag(view, 1, 100, 160);

    expect(stores.settings.setListViewColumnWidth).not.toHaveBeenCalled();
  });

  /** A drag left hanging would keep the whole page unselectable. */
  it('gives the page back its cursor and its text selection', async () => {
    const view = await mountFolder();
    await drag(view, 1, 100, 160);
    expect(document.body.style.cursor).toBe('col-resize');

    window.dispatchEvent(new MouseEvent('pointerup'));
    await flushPromises();

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});

describe('the folder itself as a drop target', () => {
  it('offers the current folder as the destination', async () => {
    const view = await mountFolder();
    const event = new Event('dragover');

    view.handleCurrentFolderDragOver(event);

    expect(composables.handleDragOver).toHaveBeenCalledWith(event, {
      destinationPath: 'Docs',
      kind: 'directory',
    });
  });

  it('drops onto it', async () => {
    const view = await mountFolder();
    const event = new Event('drop');

    view.handleCurrentFolderDrop(event);

    expect(composables.handleDrop).toHaveBeenCalledWith(event, {
      destinationPath: 'Docs',
      kind: 'directory',
    });
  });

  it('stops offering it when the pointer leaves', async () => {
    const view = await mountFolder();
    const event = new Event('dragleave');

    view.handleCurrentFolderDragLeave(event);

    expect(composables.handleDragLeave).toHaveBeenCalledWith(event, {
      destinationPath: 'Docs',
      kind: 'directory',
    });
  });

  it('opens the folder"s own menu on a right click on the background', async () => {
    const view = await mountFolder();
    const event = new Event('contextmenu');

    view.handleBackgroundContextMenu(event);

    expect(composables.openBackgroundMenu).toHaveBeenCalledWith(event);
  });
});

describe('a folder too big to draw at once', () => {
  const many = (count) => Array.from({ length: count }, (_, index) => file(`f${index}.txt`));

  it('draws the first five hundred and says there are more', async () => {
    stores.file.items = many(1200);
    stores.settings.view = 'photos';

    const view = await mountFolder();

    expect(view.hasMoreItems).toBe(true);
    expect(view.visibleItems).toHaveLength(500);
  });

  it('draws five hundred more when asked', async () => {
    stores.file.items = many(1200);
    stores.settings.view = 'photos';
    const view = await mountFolder();

    view.revealMoreItems();
    await flushPromises();

    expect(view.visibleItems).toHaveLength(1000);
  });

  it('stops at the end rather than past it', async () => {
    stores.file.items = many(600);
    stores.settings.view = 'photos';
    const view = await mountFolder();

    view.revealMoreItems();
    await flushPromises();

    expect(view.visibleItems).toHaveLength(600);
    expect(view.hasMoreItems).toBe(false);
  });

  it('starts over at five hundred when the folder changes', async () => {
    stores.file.items = many(1200);
    stores.settings.view = 'photos';
    const view = await mountFolder();
    view.revealMoreItems();
    await flushPromises();

    routeState().params = { path: 'Other' };
    await flushPromises();

    expect(view.visibleItems).toHaveLength(500);
  });
});
