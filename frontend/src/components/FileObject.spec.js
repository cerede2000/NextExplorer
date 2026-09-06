import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * One row of the folder.
 *
 * 150 statements at 5.66%, drawn once per item and holding two things worth
 * being sure of. The first is renaming: the box opens with the name selected up
 * to the extension, so typing replaces "rapport" and leaves ".docx" alone —
 * get that wrong and every rename silently drops or keeps the wrong part of the
 * name. The second is what a click means, which is not the same on a touch
 * screen as under a mouse: a tap opens, a click selects, and a long press that
 * has just opened the menu must not also be treated as a tap.
 */

const navigation = vi.hoisted(() => ({ openItem: vi.fn() }));
const selection = vi.hoisted(() => ({
  handleSelection: vi.fn(),
  toggleSelection: vi.fn(),
  isSelected: vi.fn(() => false),
}));
const contextMenu = vi.hoisted(() => ({ openItemMenu: vi.fn() }));
const dragDrop = vi.hoisted(() => ({
  canDragDrop: vi.fn(() => true),
  handleDragStart: vi.fn(),
  handleDragEnd: vi.fn(),
}));
const inputMode = vi.hoisted(() => ({ touch: false }));
const features = vi.hoisted(() => ({ folderSizeEnabled: true }));
const sizeFor = vi.hoisted(() => vi.fn(() => null));

vi.mock('@/composables/navigation', () => ({ useNavigation: () => navigation }));
vi.mock('@/composables/itemSelection', () => ({ useSelection: () => selection }));
vi.mock('@/composables/contextMenu', () => ({ useExplorerContextMenu: () => contextMenu }));
vi.mock('@/composables/useFileDragDrop', () => ({ useFileDragDrop: () => dragDrop }));
vi.mock('@/composables/useInputMode', () => ({
  useInputMode: () => ({ isTouchDevice: { get value() { return inputMode.touch; } } }),
}));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/folderSize', () => ({ useFolderSizeStore: () => ({ sizeFor }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ view: 'list', listViewColumnWidths: [0, 200, 100, 100, 160] }),
}));

/**
 * A real Pinia store, because the component reads it through `storeToRefs`,
 * which only works on one.
 */
const store = vi.hoisted(() => ({ instance: null }));
const applyRename = vi.hoisted(() => vi.fn(async () => {}));
const cancelRenameAction = vi.hoisted(() => vi.fn());
const setRenameDraft = vi.hoisted(() => vi.fn());

vi.mock('@/stores/fileStore', async () => {
  const { defineStore: define } = await import('pinia');
  const { ref: r } = await import('vue');
  const useFake = define('fileStoreFake', () => {
    const renameState = r(null);
    const selectionMode = r(false);
    const cutItems = r([]);
    return {
      renameState,
      selectionMode,
      cutItems,
      isItemBeingRenamed: (item) =>
        Boolean(renameState.value) &&
        renameState.value.name === item?.name &&
        (renameState.value.path || '') === (item?.path || ''),
      setRenameDraft,
      applyRename,
      cancelRename: cancelRenameAction,
    };
  });
  return {
    useFileStore: () => {
      store.instance = useFake();
      return store.instance;
    },
  };
});

vi.mock('@coleqiu/vue-drag-select', () => ({
  DragSelectOption: { name: 'DragSelectOption', template: '<div><slot /></div>' },
}));

const FileObject = (await import('./FileObject.vue')).default;

const FILE = { name: 'rapport.docx', path: 'Docs', kind: 'docx', size: 2048 };
const FOLDER = { name: '2026', path: 'Docs', kind: 'directory' };

let wrapper = null;

const mountRow = (item = FILE, view = 'list') => {
  wrapper = mount(FileObject, {
    props: { item, view },
    global: {
      mocks: { $t: (key) => key },
      stubs: {
        FileIcon: true,
        FolderSizeLabel: true,
        MiddleEllipsis: { template: '<span><slot /></span>' },
        InlineQuickActions: true,
      },
    },
    attachTo: document.body,
  });
  return wrapper;
};

const renaming = async (item = FILE, draft = item.name) => {
  const view = mountRow(item);
  store.instance.renameState = { name: item.name, path: item.path, kind: item.kind, draft };
  await flushPromises();
  return view;
};

const input = () => document.querySelector('input[type=text], input:not([type])');

beforeEach(() => {
  setActivePinia(createPinia());
  inputMode.touch = false;
  features.folderSizeEnabled = true;
  [
    navigation.openItem,
    selection.handleSelection,
    selection.toggleSelection,
    contextMenu.openItemMenu,
    dragDrop.handleDragStart,
    applyRename,
    cancelRenameAction,
    setRenameDraft,
    sizeFor,
  ].forEach((m) => m.mockClear());
  selection.isSelected.mockReturnValue(false);
  sizeFor.mockReturnValue(null);
  dragDrop.canDragDrop.mockReturnValue(true);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the rename box', () => {
  /**
   * Typing replaces the name and leaves the extension alone. Selecting the
   * whole thing makes every rename a chance to lose ".docx" without noticing.
   */
  it('selects the name of a file but not its extension', async () => {
    await renaming(FILE);

    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('rapport'.length);
  });

  it('selects the whole name of a folder, which has no extension', async () => {
    await renaming(FOLDER);

    expect(input().selectionEnd).toBe('2026'.length);
  });

  /** A dot in a folder name is part of the name, not an extension. */
  it('selects the whole name of a folder that has a dot in it', async () => {
    await renaming({ name: 'sauvegardes.2026', path: 'Docs', kind: 'directory' });

    expect(input().selectionEnd).toBe('sauvegardes.2026'.length);
  });

  /** A dotfile is not a file with an empty name and a ".bashrc" extension. */
  it('selects the whole name of a file that begins with a dot', async () => {
    await renaming({ name: '.bashrc', path: 'Docs', kind: 'txt' });

    expect(input().selectionEnd).toBe('.bashrc'.length);
  });

  it('selects the whole of a name with no dot in it', async () => {
    await renaming({ name: 'LISEZMOI', path: 'Docs', kind: 'txt' });

    expect(input().selectionEnd).toBe('LISEZMOI'.length);
  });

  it('takes what is typed into it', async () => {
    await renaming(FILE);

    input().value = 'bilan.docx';
    await wrapper.find('input').trigger('input');

    expect(setRenameDraft).toHaveBeenCalledWith('bilan.docx');
  });

  it('applies the name on Enter', async () => {
    await renaming(FILE);

    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(applyRename).toHaveBeenCalled();
  });

  it('gives up on Escape', async () => {
    await renaming(FILE);

    await wrapper.find('input').trigger('keydown', { key: 'Escape' });

    expect(cancelRenameAction).toHaveBeenCalled();
    expect(applyRename).not.toHaveBeenCalled();
  });

  /** Clicking away is agreeing to the name, not abandoning it. */
  it('applies the name when the box loses focus', async () => {
    await renaming(FILE);

    await wrapper.find('input').trigger('blur');
    await flushPromises();

    expect(applyRename).toHaveBeenCalled();
  });

  it('says why a rename was refused, and comes back for another try', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    applyRename.mockRejectedValueOnce(new Error('A file with that name already exists'));
    await renaming(FILE);

    await wrapper.find('input').trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(alert).toHaveBeenCalledWith('A file with that name already exists');
    expect(document.activeElement).toBe(input());
    alert.mockRestore();
  });

  it('ignores any other key', async () => {
    await renaming(FILE);

    await wrapper.find('input').trigger('keydown', { key: 'a' });

    expect(applyRename).not.toHaveBeenCalled();
    expect(cancelRenameAction).not.toHaveBeenCalled();
  });
});

describe('a row being renamed', () => {
  /** Every one of these would throw away the name half-typed into the box. */
  it('does not open on a double click', async () => {
    await renaming(FILE);

    await wrapper.find('.group\\/item > div').trigger('dblclick');

    expect(navigation.openItem).not.toHaveBeenCalled();
  });

  it('does not change the selection on a click', async () => {
    await renaming(FILE);

    await wrapper.find('.group\\/item > div').trigger('click');

    expect(selection.handleSelection).not.toHaveBeenCalled();
  });

  it('does not open the menu on a right click', async () => {
    await renaming(FILE);

    await wrapper.find('.group\\/item > div').trigger('contextmenu');

    expect(contextMenu.openItemMenu).not.toHaveBeenCalled();
  });

  it('cannot be dragged away', async () => {
    await renaming(FILE);

    expect(wrapper.find('.group\\/item > div').attributes('draggable')).toBe('false');
  });
});

describe('what a click means under a mouse', () => {
  const row = () => wrapper.find('.group\\/item > div');

  it('selects the row, with whatever modifier was held', async () => {
    mountRow();

    await row().trigger('click');

    expect(selection.handleSelection).toHaveBeenCalledWith(FILE, expect.anything());
    expect(navigation.openItem).not.toHaveBeenCalled();
  });

  it('opens it on a double click', async () => {
    mountRow();

    await row().trigger('dblclick');

    expect(navigation.openItem).toHaveBeenCalledWith(FILE);
  });

  it('opens the menu on a right click', async () => {
    mountRow();

    await row().trigger('contextmenu');

    expect(contextMenu.openItemMenu).toHaveBeenCalledWith(expect.anything(), FILE);
  });
});

describe('what a tap means on a touch screen', () => {
  const row = () => wrapper.find('.group\\/item > div');

  beforeEach(() => {
    inputMode.touch = true;
  });

  /** There is no hover and no double tap: one tap has to open it. */
  it('opens the row', async () => {
    mountRow();

    await row().trigger('click');

    expect(navigation.openItem).toHaveBeenCalledWith(FILE);
    expect(selection.handleSelection).not.toHaveBeenCalled();
  });

  it('ticks the row instead, once selecting has started', async () => {
    mountRow();
    store.instance.selectionMode = true;
    await flushPromises();

    await row().trigger('click');

    expect(selection.toggleSelection).toHaveBeenCalledWith(FILE);
    expect(navigation.openItem).not.toHaveBeenCalled();
  });

  it('does not open it on a double tap while selecting', async () => {
    mountRow();
    store.instance.selectionMode = true;
    await flushPromises();

    await row().trigger('dblclick');

    expect(navigation.openItem).not.toHaveBeenCalled();
  });
});

describe('the tick box', () => {
  const tick = () => wrapper.find('button[aria-label^="Select"]');

  it('adds the row to the selection without opening it', async () => {
    mountRow();

    await tick().trigger('click');

    expect(selection.toggleSelection).toHaveBeenCalledWith(FILE);
    expect(navigation.openItem).not.toHaveBeenCalled();
  });

  it('does nothing while the row is being renamed', async () => {
    await renaming(FILE);

    await tick().trigger('click');

    expect(selection.toggleSelection).not.toHaveBeenCalled();
  });

  /** Under a mouse it appears on hover; on a touch screen there is no hover. */
  it('is hidden on a touch screen until selecting starts', async () => {
    inputMode.touch = true;
    mountRow();

    expect(tick().exists()).toBe(false);

    store.instance.selectionMode = true;
    await flushPromises();

    expect(tick().exists()).toBe(true);
  });
});

describe('a row waiting to be moved', () => {
  it('is dimmed once it has been cut', async () => {
    mountRow();
    store.instance.cutItems = [{ name: 'rapport.docx', path: 'Docs' }];
    await flushPromises();

    expect(wrapper.find('.group\\/item > div').classes()).toContain('opacity-60');
  });

  /** Same name, different folder: not the row that was cut. */
  it('is not dimmed for a namesake somewhere else', async () => {
    mountRow();
    store.instance.cutItems = [{ name: 'rapport.docx', path: 'Archive' }];
    await flushPromises();

    expect(wrapper.find('.group\\/item > div').classes()).not.toContain('opacity-60');
  });
});

describe('the size of a folder', () => {
  it('is asked for by the folder"s own full path', async () => {
    mountRow(FOLDER);

    expect(sizeFor).toHaveBeenCalledWith('Docs/2026');
  });

  it('is not asked for where the feature is off', async () => {
    features.folderSizeEnabled = false;

    mountRow(FOLDER);

    expect(sizeFor).not.toHaveBeenCalled();
  });

  it('is not asked for a file, which carries its own', async () => {
    mountRow(FILE);

    expect(sizeFor).not.toHaveBeenCalled();
  });
});

describe('which rows the photo view shows', () => {
  const shown = (item) => {
    mountRow(item, 'photos');
    const visible = wrapper.find('.photo-cell').exists();
    wrapper.unmount();
    wrapper = null;
    return visible;
  };

  it('shows an image and a video', () => {
    expect(shown({ name: 'a.jpg', path: 'Docs', kind: 'jpg' })).toBe(true);
    expect(shown({ name: 'a.mp4', path: 'Docs', kind: 'mp4' })).toBe(true);
  });

  it('shows neither a document nor a folder', () => {
    expect(shown({ name: 'a.txt', path: 'Docs', kind: 'txt' })).toBe(false);
    expect(shown(FOLDER)).toBe(false);
  });
});

describe('a document somebody else has open', () => {
  const open = (users) => ({ ...FILE, onlyofficeActivity: { active: true, users } });

  it('says who is editing it', async () => {
    mountRow(open(['alice', 'bob']));

    expect(wrapper.html()).toContain('alice, bob');
  });

  it('says so even without knowing who', async () => {
    mountRow(open([]));

    expect(wrapper.html()).toContain('OnlyOffice');
  });

  it('says nothing for a document nobody has open', async () => {
    mountRow(FILE);

    expect(wrapper.html()).not.toContain('OnlyOffice');
  });
});
