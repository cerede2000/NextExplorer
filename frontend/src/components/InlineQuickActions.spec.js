import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, provide, reactive } from 'vue';

/**
 * The icons that appear beside a row, or beside the current folder's name, when
 * the pointer is over it.
 *
 * They are a second right-click menu, one hover away and without the chance to
 * read a label first — so an icon that stays live where the location forbids
 * it is clicked before anyone wonders whether it should be there. The decision
 * of what a row may do belongs to the right-click machinery; this component's
 * part is to ask it about the right item, to keep row-only actions (delete,
 * rename, share…) off the folder you are standing in, and to run what was
 * clicked without the click also opening the row underneath.
 */

let quickActions;
let favorites;
let folderActions;

vi.mock('@/stores/quickActions', () => ({ useQuickActionsStore: () => quickActions }));
vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => favorites }));
vi.mock('@/composables/useFolderQuickActions', () => ({
  useFolderQuickActions: () => folderActions,
}));
vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

import InlineQuickActions from './InlineQuickActions.vue';
import { explorerContextMenuSymbol } from '@/composables/contextMenu';

const FILE = { name: 'report.docx', path: 'Docs', kind: 'docx' };
const FOLDER = { name: '2026', path: 'Docs', kind: 'directory' };

const EVERY_ACTION = [
  'info',
  'download',
  'copyName',
  'copyPath',
  'copy',
  'cut',
  'rename',
  'share',
  'compress',
  'favorite',
  'delete',
];

/** Each action is named by its translation key, which is what `t` returns. */
const LABEL = {
  info: 'context.getInfo',
  download: 'actions.download',
  copyName: 'actions.copyName',
  copyPath: 'actions.copyPath',
  copy: 'actions.copy',
  cut: 'actions.cut',
  rename: 'actions.rename',
  share: 'actions.share',
  compress: 'actions.compressToZip',
  favorite: 'context.addToFavorites',
  delete: 'common.delete',
};

/**
 * The right-click machinery as a row sees it. What it refuses stands for a
 * location's permissions: on a read-only share, for instance, nothing that
 * writes, deletes or re-shares is allowed. A favourite is for folders only.
 */
const makeContext = (refused = []) => ({
  quickActionAvailable: vi.fn((item, id) => {
    if (!item || refused.includes(id)) return false;
    if (id === 'favorite') return item.kind === 'directory';
    return true;
  }),
  runQuickAction: vi.fn(async () => {}),
});

let wrapper = null;
let rowClick;

/**
 * Mounted inside a row that listens for clicks, and under the context menu's
 * provider the way a real row is.
 */
const mountActions = async (initialProps, context = makeContext()) => {
  const props = reactive({ active: true, ...initialProps });
  rowClick = vi.fn();
  const Row = defineComponent({
    setup() {
      provide(explorerContextMenuSymbol, context);
      return () => h('div', { onClick: rowClick }, [h(InlineQuickActions, { ...props })]);
    },
  });
  wrapper = mount(Row, { attachTo: document.body });
  await flushPromises();
  return { props, context };
};

const offered = () => wrapper.findAll('button').map((button) => button.attributes('aria-label'));
const button = (label) => wrapper.find(`button[aria-label="${label}"]`);

beforeEach(() => {
  quickActions = reactive({ enabled: true, displayMode: 'full', enabledActionIds: EVERY_ACTION });
  favorites = { isFavorite: vi.fn(() => false) };
  folderActions = {
    available: vi.fn(() => true),
    run: vi.fn(async () => {}),
    isFavorite: vi.fn(() => false),
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('on a row', () => {
  it('shows nothing until the row is hovered', async () => {
    const { props } = await mountActions({ item: FILE, active: false });
    expect(offered()).toEqual([]);

    props.active = true;
    await flushPromises();

    expect(offered()).toContain(LABEL.info);
  });

  it('shows nothing when quick actions are switched off', async () => {
    quickActions.enabled = false;
    await mountActions({ item: FILE });

    expect(offered()).toEqual([]);
  });

  it('offers the configured actions in the configured order', async () => {
    quickActions.enabledActionIds = ['delete', 'info', 'rename', 'download'];
    await mountActions({ item: FILE });

    expect(offered()).toEqual([LABEL.delete, LABEL.info, LABEL.rename, LABEL.download]);
  });

  it('does not offer on a read-only share what the share forbids', async () => {
    const { context } = await mountActions(
      { item: FILE },
      makeContext(['cut', 'rename', 'share', 'compress', 'delete'])
    );

    expect(offered()).toEqual([
      LABEL.info,
      LABEL.download,
      LABEL.copyName,
      LABEL.copyPath,
      LABEL.copy,
    ]);
    // Asked about this row's item, for each action, rather than decided here.
    expect(context.quickActionAvailable).toHaveBeenCalledWith(FILE, 'delete');
    expect(context.quickActionAvailable).toHaveBeenCalledWith(FILE, 'rename');
  });

  it('offers nothing when the row is not allowed anything', async () => {
    await mountActions({ item: FILE }, makeContext(EVERY_ACTION));

    expect(offered()).toEqual([]);
  });

  it('ignores an action the catalogue no longer knows, instead of failing to render', async () => {
    quickActions.enabledActionIds = ['info', 'teleport'];
    const { context } = await mountActions({ item: FILE });

    expect(offered()).toEqual([LABEL.info]);
    expect(context.quickActionAvailable).not.toHaveBeenCalledWith(FILE, 'teleport');
  });

  it('runs the clicked action on the row it belongs to', async () => {
    const { context } = await mountActions({ item: FILE });

    await button(LABEL.rename).trigger('click');
    await flushPromises();

    expect(context.runQuickAction).toHaveBeenCalledTimes(1);
    expect(context.runQuickAction).toHaveBeenCalledWith(FILE, 'rename');
  });

  it('does not let the click through to the row, which would open or select it', async () => {
    await mountActions({ item: FILE });

    await button(LABEL.delete).trigger('click');

    expect(rowClick).not.toHaveBeenCalled();
  });

  it('reports an action that fails rather than throwing it at the row', async () => {
    const context = makeContext();
    context.runQuickAction.mockRejectedValue(new Error('gone'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mountActions({ item: FILE }, context);

    await button(LABEL.download).trigger('click');
    await flushPromises();

    expect(consoleError).toHaveBeenCalledWith('Quick action "download" failed', expect.any(Error));
  });
});

describe('the favourite action on a folder row', () => {
  it('offers to add a folder that is not a favourite yet', async () => {
    await mountActions({ item: FOLDER });

    expect(offered()).toContain('context.addToFavorites');
    expect(offered()).not.toContain('context.removeFromFavorites');
  });

  it('offers to remove a folder that already is one, looked up by its full path', async () => {
    favorites.isFavorite = vi.fn((path) => path === 'Docs/2026');
    await mountActions({ item: FOLDER });

    expect(offered()).toContain('context.removeFromFavorites');
    expect(offered()).not.toContain('context.addToFavorites');
  });

  it('is not offered on a file', async () => {
    await mountActions({ item: FILE });

    expect(offered()).not.toContain('context.addToFavorites');
    expect(favorites.isFavorite).not.toHaveBeenCalled();
  });
});

describe('compact mode', () => {
  it('shows a single "more" button until it is hovered, and running nothing when it is clicked', async () => {
    quickActions.displayMode = 'compact';
    const { context } = await mountActions({ item: FILE });

    expect(offered()).toEqual(['quickActions.menu']);
    await button('quickActions.menu').trigger('click');
    expect(context.runQuickAction).not.toHaveBeenCalled();
    expect(rowClick).not.toHaveBeenCalled();

    await wrapper.find('button').element.parentElement.dispatchEvent(new Event('mouseenter'));
    await flushPromises();

    expect(offered()).toContain(LABEL.delete);
    expect(offered()).not.toContain('quickActions.menu');
  });

  it('shows a lone action directly rather than hiding it behind "more"', async () => {
    quickActions.displayMode = 'compact';
    quickActions.enabledActionIds = ['info'];
    await mountActions({ item: FILE });

    expect(offered()).toEqual([LABEL.info]);
  });
});

describe('on the current folder', () => {
  it('never offers the folder you are in an action meant for a row', async () => {
    const context = makeContext();
    await mountActions({ folder: true }, context);

    expect(offered()).toEqual([LABEL.info, LABEL.copyName, LABEL.copyPath, LABEL.favorite]);
    expect(folderActions.available).toHaveBeenCalledWith('info');
  });

  it('offers nothing where the folder actions refuse, as on the list of volumes', async () => {
    folderActions.available = vi.fn(() => false);
    await mountActions({ folder: true });

    expect(offered()).toEqual([]);
  });

  it('runs the clicked action on the folder, not through the row menu', async () => {
    const context = makeContext();
    await mountActions({ folder: true }, context);

    await button(LABEL.copyPath).trigger('click');
    await flushPromises();

    expect(folderActions.run).toHaveBeenCalledWith('copyPath');
    expect(context.runQuickAction).not.toHaveBeenCalled();
    expect(context.quickActionAvailable).not.toHaveBeenCalled();
  });

  it('offers to remove the folder from favourites when it is one', async () => {
    folderActions.isFavorite = vi.fn(() => true);
    await mountActions({ folder: true });

    expect(offered()).toContain('context.removeFromFavorites');
    expect(favorites.isFavorite).not.toHaveBeenCalled();
  });
});
