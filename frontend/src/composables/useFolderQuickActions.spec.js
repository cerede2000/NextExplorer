import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The little menu on the folder name at the top of the toolbar.
 *
 * Its whole design is a restriction, and the restriction is the thing to test.
 * The toolbar sits outside the context-menu provider, so this offers only the
 * four actions that work on a path directly and none that could act
 * destructively on the folder somebody is currently standing in — no delete,
 * no rename, no compress. A fifth id slipping into that list is the failure
 * mode, and it would look like a feature.
 *
 * The rest is the path itself, split into a name and a parent so the info panel
 * and the clipboard get the same answer the explorer would give.
 */

let routeParams;
let currentStorePath;
let favorites;
const infoOpen = vi.fn();
const openEditorForFavorite = vi.fn();
const writeText = vi.fn();

vi.mock('vue-router', () => ({ useRoute: () => ({ params: routeParams }) }));
vi.mock('@/stores/fileStore', () => ({
  useFileStore: () => ({
    get getCurrentPath() {
      return currentStorePath;
    },
  }),
}));
vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => favorites }));
vi.mock('@/stores/infoPanel', () => ({ useInfoPanelStore: () => ({ open: infoOpen }) }));
vi.mock('@/composables/useFavoriteEditor', () => ({
  useFavoriteEditor: () => ({ openEditorForFavorite }),
}));
vi.mock('@/api', () => ({
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));

import { useFolderQuickActions } from './useFolderQuickActions';

beforeEach(() => {
  routeParams = { path: 'Docs/2026' };
  currentStorePath = '';
  favorites = {
    isFavorite: vi.fn(() => false),
    addFavorite: vi.fn().mockResolvedValue({ id: 'f1', path: 'Docs/2026' }),
    removeFavorite: vi.fn().mockResolvedValue(),
  };
  [infoOpen, openEditorForFavorite, writeText].forEach((m) => m.mockReset());
  writeText.mockResolvedValue();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

describe('which folder it is acting on', () => {
  it('reads the path from the route', () => {
    expect(useFolderQuickActions().currentPath()).toBe('Docs/2026');
  });

  /** Vue router gives a wildcard as an array of segments. */
  it('joins a route path that arrived in segments', () => {
    routeParams = { path: ['Docs', '2026', 'q1'] };

    expect(useFolderQuickActions().currentPath()).toBe('Docs/2026/q1');
  });

  it('falls back to the store when the route says nothing', () => {
    routeParams = {};
    currentStorePath = 'Media';

    expect(useFolderQuickActions().currentPath()).toBe('Media');
  });

  it('normalises stray slashes away', () => {
    routeParams = { path: '/Docs/2026/' };

    expect(useFolderQuickActions().currentPath()).toBe('Docs/2026');
  });

  it('is empty at the root, where there is no folder to act on', () => {
    routeParams = {};

    expect(useFolderQuickActions().currentPath()).toBe('');
  });
});

describe('what it will and will not offer', () => {
  it.each(['info', 'favorite', 'copyName', 'copyPath'])('offers %s', (id) => {
    expect(useFolderQuickActions().available(id)).toBe(true);
  });

  /**
   * The point of the list. These act on a selection or destructively, and the
   * folder in question is the one somebody is standing in.
   */
  it.each(['delete', 'rename', 'cut', 'copy', 'paste', 'compress', 'extract', 'download'])(
    'never offers %s',
    (id) => {
      expect(useFolderQuickActions().available(id)).toBe(false);
    }
  );

  it('offers nothing at all at the root', () => {
    routeParams = {};

    const actions = useFolderQuickActions();
    for (const id of ['info', 'favorite', 'copyName', 'copyPath']) {
      expect(actions.available(id)).toBe(false);
    }
  });
});

describe('running one', () => {
  it('opens the info panel on the folder, split into a name and a parent', async () => {
    await useFolderQuickActions().run('info');

    expect(infoOpen).toHaveBeenCalledWith({ name: '2026', path: 'Docs', kind: 'directory' });
  });

  it('describes a top-level folder as having no parent', async () => {
    routeParams = { path: 'Media' };

    await useFolderQuickActions().run('info');

    expect(infoOpen).toHaveBeenCalledWith({ name: 'Media', path: '', kind: 'directory' });
  });

  it('copies the folder name, not the whole path', async () => {
    await useFolderQuickActions().run('copyName');

    expect(writeText).toHaveBeenCalledWith('2026');
  });

  it('copies the whole path when asked for the path', async () => {
    await useFolderQuickActions().run('copyPath');

    expect(writeText).toHaveBeenCalledWith('Docs/2026');
  });

  /** An insecure context has no clipboard; copying must fail quietly. */
  it('does not throw when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect(useFolderQuickActions().run('copyPath')).resolves.toBeUndefined();
  });

  it('does not throw when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));

    await expect(useFolderQuickActions().run('copyPath')).resolves.toBeUndefined();
  });

  it('does nothing at all at the root', async () => {
    routeParams = {};

    await useFolderQuickActions().run('info');

    expect(infoOpen).not.toHaveBeenCalled();
  });

  it('shrugs at an id it does not know', async () => {
    await expect(useFolderQuickActions().run('teleport')).resolves.toBeUndefined();
    expect(infoOpen).not.toHaveBeenCalled();
  });
});

describe('the favourite toggle', () => {
  it('adds the folder when it is not one', async () => {
    await useFolderQuickActions().run('favorite');

    expect(favorites.addFavorite).toHaveBeenCalledWith({ path: 'Docs/2026' });
    expect(favorites.removeFavorite).not.toHaveBeenCalled();
  });

  it('removes it when it already is', async () => {
    favorites.isFavorite = vi.fn(() => true);

    await useFolderQuickActions().run('favorite');

    expect(favorites.removeFavorite).toHaveBeenCalledWith('Docs/2026');
    expect(favorites.addFavorite).not.toHaveBeenCalled();
  });

  /** A new favourite opens its editor so the label can be typed straight away. */
  it('opens the label editor on the one it just added', async () => {
    await useFolderQuickActions().run('favorite');

    expect(openEditorForFavorite).toHaveBeenCalledWith({ id: 'f1', path: 'Docs/2026' });
  });

  it('does not open an editor when the server returned nothing', async () => {
    favorites.addFavorite = vi.fn().mockResolvedValue(null);

    await useFolderQuickActions().run('favorite');

    expect(openEditorForFavorite).not.toHaveBeenCalled();
  });

  it('reports whether the current folder is a favourite', () => {
    favorites.isFavorite = vi.fn((p) => p === 'Docs/2026');

    expect(useFolderQuickActions().isFavorite()).toBe(true);
  });

  it('is never a favourite at the root', () => {
    routeParams = {};
    favorites.isFavorite = vi.fn(() => true);

    expect(useFolderQuickActions().isFavorite()).toBe(false);
  });
});
