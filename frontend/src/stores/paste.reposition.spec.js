import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const routerPush = vi.fn(() => Promise.resolve());
const copyItems = vi.fn();
const moveItems = vi.fn();
const browse = vi.fn();
const addNotification = vi.fn();

vi.mock('@/router', () => ({
  default: { push: (...args) => routerPush(...args) },
}));

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  copyItems: (...args) => copyItems(...args),
  moveItems: (...args) => moveItems(...args),
  deleteItems: vi.fn(),
  // Kept identical to the real helper: strips leading/trailing slashes.
  normalizePath: (p) => (p || '').replace(/^\/+|\/+$/g, ''),
  createFolder: vi.fn(),
  renameItem: vi.fn(),
  saveFileContent: vi.fn(),
  fetchThumbnail: vi.fn(),
  extractZip: vi.fn(),
  compressToZip: vi.fn(),
  browseShare: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    sortBy: { by: 'name', order: 'asc' },
    restoreFolderPreferences: vi.fn(),
  }),
}));
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ thumbnailsEnabledForSession: true }),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: (...args) => addNotification(...args) }),
}));
vi.mock('@/stores/favorites', () => ({
  useFavoritesStore: () => ({ loadFavorites: vi.fn() }),
}));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: vi.fn() }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: vi.fn(), sizeFor: () => null }),
}));

import { useFileStore } from '@/stores/fileStore';

// browse() returns a listing containing the pasted entry so that, after an
// in-place refresh, the store can re-select it by name.
const listingWith = (name, parent) => ({
  items: [{ name, path: parent, kind: 'file' }],
  path: parent,
});

describe('fileStore paste repositioning', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routerPush.mockClear();
    copyItems.mockReset();
    moveItems.mockReset();
    browse.mockReset();
    addNotification.mockReset();
  });

  it('reposition ON, still on destination: refreshes in place and selects the pasted entry (no navigation)', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });
    browse.mockResolvedValue(listingWith('f.bin', 'Usb/temp'));

    const store = useFileStore();
    store.repositionAfterTransfer = true;
    store.setCurrentPath('Usb/temp'); // user is viewing the destination
    store.copiedItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste();

    expect(routerPush).not.toHaveBeenCalled();
    expect(browse).toHaveBeenCalledWith(
      'Usb/temp',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(store.selectedItems.map((i) => i.name)).toEqual(['f.bin']);
    expect(store.copiedItems).toEqual([]);
  });

  it('reposition ON, navigated away: navigates to the destination with a select query (updates the address bar)', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });

    const store = useFileStore();
    store.repositionAfterTransfer = true;
    store.setCurrentPath('some/other/folder'); // user browsed elsewhere during the copy
    store.copiedItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste('Usb/temp');

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      path: '/browse/Usb/temp',
      query: { select: 'f.bin' },
    });
    // The router-driven remount performs the fetch; the store must not refresh directly.
    expect(browse).not.toHaveBeenCalled();
  });

  it('reposition OFF, still on destination: refreshes in place without navigating', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });
    browse.mockResolvedValue(listingWith('f.bin', 'Usb/temp'));

    const store = useFileStore();
    store.repositionAfterTransfer = false;
    store.setCurrentPath('Usb/temp');
    store.copiedItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste();

    expect(routerPush).not.toHaveBeenCalled();
    expect(browse).toHaveBeenCalledWith(
      'Usb/temp',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('reposition OFF, navigated to an unaffected folder: leaves the view untouched (no fetch, no navigation)', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });

    const store = useFileStore();
    store.repositionAfterTransfer = false;
    store.setCurrentPath('unrelated/place');
    store.copiedItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste('Usb/temp');

    expect(routerPush).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
  });

  it('reposition OFF, viewing a move source: refreshes it so removed entries disappear', async () => {
    moveItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });
    browse.mockResolvedValue({ items: [], path: 'src' });

    const store = useFileStore();
    store.repositionAfterTransfer = false;
    store.setCurrentPath('src'); // viewing the folder the item is being moved out of
    store.cutItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste('Usb/temp');

    expect(routerPush).not.toHaveBeenCalled();
    expect(browse).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(store.cutItems).toEqual([]);
  });

  it('clears only the cancelled move items so their source no longer appears cut', async () => {
    moveItems.mockRejectedValue(new Error('Request aborted'));
    browse.mockResolvedValue(listingWith('f.bin', 'src'));

    const store = useFileStore();
    store.setCurrentPath('src');
    store.cutItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste('Usb/temp');

    expect(store.cutItems).toEqual([]);
    expect(browse).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

/**
 * A paste that arrived short of something has to say so.
 *
 * The server skips an entry whose name does not decode rather than failing the
 * copy over it, and answers how many. The store is where that answer becomes a
 * sentence: without this the copy finishes, the listing refreshes, the entry is
 * selected, and nobody is told that files are missing from it.
 */
describe('a paste the server could not read everything for', () => {
  // The suite above keeps its own `beforeEach` inside its describe, and the
  // clipboard is kept in `localStorage`: without this, what the test before
  // put on it is still there.
  beforeEach(() => {
    setActivePinia(createPinia());
    copyItems.mockReset();
    moveItems.mockReset();
    browse.mockReset();
    addNotification.mockReset();
    window.localStorage.clear();
  });

  it('says how many entries were left out', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/Work', to: 'Usb/temp/Work' }],
      destination: 'Usb/temp',
      unreadable: 2,
    });
    browse.mockResolvedValue(listingWith('Work', 'Usb/temp'));

    const store = useFileStore();
    store.setCurrentPath('Usb/temp');
    store.copiedItems = [{ name: 'Work', path: 'src', kind: 'directory' }];

    await store.paste();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({ type: 'warning' });
  });

  it('says nothing when the copy was whole', async () => {
    copyItems.mockResolvedValue({
      items: [{ from: 'src/f.bin', to: 'Usb/temp/f.bin' }],
      destination: 'Usb/temp',
    });
    browse.mockResolvedValue(listingWith('f.bin', 'Usb/temp'));

    const store = useFileStore();
    store.setCurrentPath('Usb/temp');
    store.copiedItems = [{ name: 'f.bin', path: 'src', kind: 'file' }];

    await store.paste();

    expect(addNotification).not.toHaveBeenCalled();
  });
});
