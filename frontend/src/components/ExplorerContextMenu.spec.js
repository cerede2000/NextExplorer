import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, inject, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The right-click menu.
 *
 * 409 statements at 0.7%, and it is where a permission becomes a thing somebody
 * can click. Everything the explorer refuses is refused twice — once by the
 * guard that runs the action, once by this menu deciding whether to offer it —
 * and the second one is what people actually see. An entry that stays live on a
 * read-only share is not a cosmetic problem: it is a person told they may do
 * something, finding out afterwards that they may not.
 *
 * The menu is three different menus depending on what was clicked — the
 * background, a file, a folder — and the differences are the interesting part.
 * Paste belongs to a folder and the background but not to a file. Rename needs
 * a target. Open-in-terminal is for a file only, and only where the terminal is
 * switched on at all.
 */

let actions;
let fileStore;
let features;
let favorites;

const infoOpen = vi.fn();
const terminalOpen = vi.fn();
const routerPush = vi.fn();

vi.mock('@floating-ui/vue', () => ({
  useFloating: () => ({ x: ref(0), y: ref(0), strategy: ref('fixed'), update: vi.fn() }),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn(),
  autoUpdate: vi.fn(),
  size: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock('@/composables/fileActions', () => ({ useFileActions: () => actions }));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/stores/infoPanel', () => ({ useInfoPanelStore: () => ({ open: infoOpen }) }));
vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => favorites }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/terminal', () => ({ useTerminalStore: () => ({ open: terminalOpen }) }));
vi.mock('@/composables/itemSelection', () => ({
  useSelection: () => ({ clearSelection: vi.fn() }),
}));
vi.mock('@/composables/useFavoriteEditor', () => ({
  useFavoriteEditor: () => ({ openEditorForFavorite: vi.fn() }),
}));
// The menu pulls in the share dialog, which is a screen of its own with a date
// picker in it. Stubbed: nothing here is about creating a share.
vi.mock('@/components/ShareDialog.vue', () => ({
  default: defineComponent({ name: 'ShareDialogStub', render: () => null }),
}));

import ExplorerContextMenu from './ExplorerContextMenu.vue';
import { explorerContextMenuSymbol as realSymbol } from '@/composables/contextMenu';

const FILE = { name: 'report.docx', path: 'Docs', kind: 'docx' };
const FOLDER = { name: '2026', path: 'Docs', kind: 'directory' };

const makeActions = (overrides = {}) => ({
  selectedItems: ref([FILE]),
  primaryItem: ref(FILE),
  isSingleItemSelected: ref(true),
  hasSelection: ref(true),
  canRename: ref(true),
  canCut: ref(true),
  canCopy: ref(true),
  canPaste: ref(true),
  canDelete: ref(true),
  canExtractArchive: ref(false),
  canCompressToZip: ref(true),
  canDownloadCurrentFolder: ref(false),
  isArchiveSelected: ref(false),
  isCutActive: ref(false),
  isCopyActive: ref(false),
  locationCanWrite: ref(true),
  locationCanCreateFolder: ref(true),
  locationCanCreateFile: ref(true),
  locationCanDelete: ref(true),
  locationCanUpload: ref(true),
  locationCanDownload: ref(true),
  resolveItemPath: (item) => (item?.path ? `${item.path}/${item.name}` : item?.name || ''),
  isEditableElement: () => false,
  runCut: vi.fn(),
  runCopy: vi.fn(),
  runRename: vi.fn(),
  runMoveTo: vi.fn(),
  runCopyTo: vi.fn(),
  runPasteToDestination: vi.fn(),
  runPasteIntoCurrent: vi.fn(),
  runExtractArchive: vi.fn(),
  runExtractArchiveIntoCurrentFolder: vi.fn(),
  runCompressToZip: vi.fn(),
  runDownload: vi.fn(),
  runDownloadCurrentFolder: vi.fn(),
  deleteNow: vi.fn(),
  ...overrides,
});

let mounted = null;

/** Mounts the menu with a child that captures the API it provides. */
const mountMenu = async () => {
  let api = null;
  const Child = defineComponent({
    setup() {
      api = inject(realSymbol);
      return () => h('div', 'child');
    },
  });
  const wrapper = mount(ExplorerContextMenu, {
    slots: { default: () => h(Child) },
    attachTo: document.body,
    // The template uses the global `$t` as well as the `t` from useI18n, and a
    // missing one throws during render rather than showing an untranslated
    // string — which looks exactly like the menu refusing to open.
    global: { mocks: { $t: (key) => key } },
  });
  mounted = wrapper;
  await flushPromises();
  return { wrapper, api };
};

const rightClick = () => ({
  clientX: 100,
  clientY: 100,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

/**
 * The menu is teleported to the body, so it is read from the document rather
 * than from the wrapper. `t` is mocked to return the key it was given, so each
 * entry is identified by its translation key — stable, and it does not require
 * adding attributes to the component just to be testable.
 */
const menuPanel = () =>
  [...document.body.querySelectorAll('div')].find((el) => el.className.includes('min-w-[220px]'));

const isOpen = () => Boolean(menuPanel());

const entries = () =>
  [...(menuPanel()?.querySelectorAll('button') ?? [])].map((button) => ({
    label: button.querySelector('p')?.textContent?.trim() ?? '',
    disabled: button.disabled,
  }));

const labels = () => entries().map((entry) => entry.label);

const isDisabled = (label) => entries().find((entry) => entry.label === label)?.disabled;

/**
 * Unmounted between tests, not just cleared: the menu registers keydown and
 * pointerdown listeners on `window`, and a component left mounted keeps
 * answering them. That is how an Escape test that passes alone fails in a run.
 */
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = '';
  setActivePinia(createPinia());
  [infoOpen, terminalOpen, routerPush].forEach((m) => m.mockReset());
  actions = makeActions();
  fileStore = {
    selectedItems: [FILE],
    get selectedItemKeys() {
      return new Set(fileStore.selectedItems.map((i) => `${i.path}::${i.name}`));
    },
    getCurrentPathItems: [FILE, FOLDER],
    currentPath: 'Docs',
    getCurrentPath: 'Docs',
    currentPathData: { canWrite: true, canDelete: true },
    createFolder: vi.fn(),
    createFile: vi.fn(),
    createOfficeDocument: vi.fn(),
  };
  features = {
    terminalEnabled: true,
    terminalExtensions: ['sh', 'py'],
    archiveExtensions: ['zip'],
    onlyofficeEnabled: false,
  };
  favorites = {
    isFavorite: vi.fn(() => false),
    addFavorite: vi.fn().mockResolvedValue({ id: 'f1' }),
    removeFavorite: vi.fn().mockResolvedValue(),
  };
});

describe('opening it', () => {
  it('stays shut until something asks for it', async () => {
    await mountMenu();

    expect(isOpen()).toBe(false);
  });

  it('opens on a right-click on a file', async () => {
    const { api } = await mountMenu();

    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    expect(isOpen()).toBe(true);
  });

  it('opens on a right-click on the background', async () => {
    const { api } = await mountMenu();

    api.openBackgroundMenu(rightClick());
    await flushPromises();

    expect(isOpen()).toBe(true);
  });

  /** A right-click must not also trigger the browser's own menu. */
  it('takes the event away from the browser', async () => {
    const { api } = await mountMenu();
    const event = rightClick();

    api.openItemMenu(event, FILE);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('ignores a call with no event, and one with no item', async () => {
    const { api } = await mountMenu();

    api.openItemMenu(null, FILE);
    api.openItemMenu(rightClick(), null);
    await flushPromises();

    expect(isOpen()).toBe(false);
  });

  it('closes again', async () => {
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    api.closeMenu();
    await flushPromises();

    expect(isOpen()).toBe(false);
  });

  /** Escape closes it, because a menu that traps the keyboard is a bug. */
  it('closes on Escape', async () => {
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(isOpen()).toBe(false);
  });
});

describe('what a right-click selects', () => {
  /**
   * Right-clicking a row that is not in the selection selects it. Without this
   * the menu acts on whatever was selected before, which is the wrong file.
   */
  it('selects the row it was opened on', async () => {
    const { api } = await mountMenu();
    fileStore.selectedItems = [FOLDER];

    api.openItemMenu(rightClick(), FILE);

    expect(fileStore.selectedItems.map((i) => i.name)).toEqual(['report.docx']);
  });

  /** Right-clicking inside a multi-selection keeps it, so a bulk action works. */
  it('leaves a selection alone when the row is already in it', async () => {
    const { api } = await mountMenu();
    fileStore.selectedItems = [FILE, FOLDER];

    api.openItemMenu(rightClick(), FILE);

    expect(fileStore.selectedItems).toHaveLength(2);
  });
});

describe('what each of the three menus offers', () => {
  const openOn = async (kind) => {
    mounted?.unmount();
    document.body.innerHTML = '';
    const { api } = await mountMenu();
    if (kind === 'background') api.openBackgroundMenu(rightClick());
    else api.openItemMenu(rightClick(), kind === 'directory' ? FOLDER : FILE);
    await flushPromises();
  };

  it('offers creation on the background, where there is nothing selected to act on', async () => {
    await openOn('background');

    expect(labels()).toEqual(expect.arrayContaining(['actions.newFolder', 'actions.newFile']));
  });

  it('offers cut, copy and rename on a file', async () => {
    await openOn('file');

    expect(labels()).toEqual(
      expect.arrayContaining(['actions.cut', 'actions.copy', 'actions.rename'])
    );
  });

  /**
   * Paste goes into a folder, and into the folder being looked at. Pasting
   * "into" a file is not a thing, and offering it is a click that can only fail.
   */
  it('offers paste on a folder but not on a file', async () => {
    await openOn('directory');
    expect(labels()).toContain('actions.paste');

    await openOn('file');
    expect(labels()).not.toContain('actions.paste');
  });

  /**
   * A second condition beyond the kind: the terminal is offered for a file it
   * could actually run, which is what `TERMINAL_EXTENSIONS` names. A .docx has
   * no terminal entry, and that is right.
   */
  it('offers the terminal for a script', async () => {
    const script = { name: 'deploy.sh', path: 'Docs', kind: 'sh' };
    actions = makeActions({ primaryItem: ref(script), selectedItems: ref([script]) });
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), script);
    await flushPromises();

    expect(labels()).toContain('context.openWithTerminal');
  });

  it('does not offer it for a document, which the terminal could not run', async () => {
    await openOn('file');

    expect(labels()).not.toContain('context.openWithTerminal');
  });

  it('offers no terminal on a folder', async () => {
    await openOn('directory');

    expect(labels()).not.toContain('context.openWithTerminal');
  });

  it('offers no terminal at all where the deployment has it switched off', async () => {
    features.terminalEnabled = false;
    const script = { name: 'deploy.sh', path: 'Docs', kind: 'sh' };
    actions = makeActions({ primaryItem: ref(script), selectedItems: ref([script]) });

    await openOn('file');

    expect(labels()).not.toContain('context.openWithTerminal');
  });

  it('offers favourites on a folder', async () => {
    await openOn('directory');

    expect(labels()).toContain('context.addToFavorites');
  });

  it('says remove rather than add for a folder already favourited', async () => {
    favorites.isFavorite = vi.fn(() => true);

    await openOn('directory');

    expect(labels()).toContain('context.removeFromFavorites');
    expect(labels()).not.toContain('context.addToFavorites');
  });

  it('offers extraction only for an archive', async () => {
    await openOn('file');
    expect(labels()).not.toContain('actions.extractArchive');

    actions = makeActions({ canExtractArchive: ref(true), isArchiveSelected: ref(true) });
    await openOn('file');
    expect(labels()).toContain('actions.extractArchive');
  });
});

describe('what it will not offer where the location forbids it', () => {
  const openOnFile = async (overrides) => {
    actions = makeActions(overrides);
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();
  };

  const openOnBackground = async (overrides) => {
    actions = makeActions(overrides);
    const { api } = await mountMenu();
    api.openBackgroundMenu(rightClick());
    await flushPromises();
  };

  /**
   * The rename entry is built inside `if (locationCanWrite)`, so a read-only
   * location has no rename at all rather than a greyed-out one.
   */
  it('drops rename entirely on a read-only location', async () => {
    await openOnFile({ locationCanWrite: ref(false) });

    expect(labels()).not.toContain('actions.rename');
  });

  it('greys out rename where the target itself cannot be renamed', async () => {
    await openOnFile({ canRename: ref(false) });

    expect(isDisabled('actions.rename')).toBe(true);
  });

  it('greys out cut and copy when there is nothing to cut or copy', async () => {
    await openOnFile({ canCut: ref(false), canCopy: ref(false) });

    expect(isDisabled('actions.cut')).toBe(true);
    expect(isDisabled('actions.copy')).toBe(true);
  });

  it('offers no folder creation where folders may not be created', async () => {
    await openOnBackground({ locationCanCreateFolder: ref(false) });

    expect(labels()).not.toContain('actions.newFolder');
  });

  it('offers no file creation where files may not be created', async () => {
    await openOnBackground({ locationCanCreateFile: ref(false) });

    expect(labels()).not.toContain('actions.newFile');
  });

  it('greys out compressing when the selection cannot be zipped', async () => {
    await openOnFile({ canCompressToZip: ref(false) });

    expect(isDisabled('actions.compressToZip')).toBe(true);
  });
});

describe('running an entry', () => {
  const clickEntry = async (label) => {
    const button = [...menuPanel().querySelectorAll('button')].find(
      (candidate) => candidate.querySelector('p')?.textContent?.trim() === label
    );
    button.click();
    await flushPromises();
  };

  it('cuts', async () => {
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    await clickEntry('actions.cut');

    expect(actions.runCut).toHaveBeenCalled();
  });

  it('opens the info panel on what was clicked', async () => {
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    await clickEntry('context.getInfo');

    expect(infoOpen).toHaveBeenCalled();
  });

  /** A menu that stays open over the thing it just acted on is in the way. */
  it('closes itself afterwards', async () => {
    const { api } = await mountMenu();
    api.openItemMenu(rightClick(), FILE);
    await flushPromises();

    await clickEntry('actions.copy');

    expect(isOpen()).toBe(false);
  });
});
