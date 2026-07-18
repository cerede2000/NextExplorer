import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

const browse = vi.fn();
const deleteItemsStream = vi.fn();
const loadFavorites = vi.fn();

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  deleteItemsStream: (...args) => deleteItemsStream(...args),
  browseShare: vi.fn(),
  normalizePath: (path = '') => String(path).replace(/^\/+|\/+$/g, ''),
  copyItems: vi.fn(),
  moveItems: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  renameItem: vi.fn(),
  fetchThumbnail: vi.fn(),
  extractZip: vi.fn(),
  compressToZip: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ sortBy: { by: 'name', order: 'asc' } }),
}));

vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ thumbnailsEnabledForSession: false }),
}));

vi.mock('@/stores/favorites', () => ({
  useFavoritesStore: () => ({ loadFavorites }),
}));

vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: vi.fn() }),
}));

vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: vi.fn() }),
}));

vi.mock('@vueuse/core', () => ({
  useStorage: (_key, initialValue) => ref(initialValue),
}));

import { useFileStore } from './fileStore';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('fileStore deletion feedback', () => {
  const removed = { name: 'remove-me.txt', path: 'Volume', kind: 'file' };
  const retained = { name: 'keep-me.txt', path: 'Volume', kind: 'file' };

  beforeEach(() => {
    setActivePinia(createPinia());
    browse.mockReset();
    deleteItemsStream.mockReset();
    loadFavorites.mockReset();
    loadFavorites.mockResolvedValue([]);
  });

  it('removes confirmed items from the active listing before the stream completes', async () => {
    const stream = deferred();
    deleteItemsStream.mockImplementation((_items, { onEvent }) => {
      onEvent({ type: 'start', phase: 'preparing', totalItems: 1 });
      return stream.promise;
    });
    browse.mockResolvedValue({ path: 'Volume', items: [retained] });

    const store = useFileStore();
    store.setCurrentPath('Volume');
    store.currentPathItems = [removed, retained];
    store.selectedItems = [removed];

    const deletion = store.del();
    await Promise.resolve();

    expect(store.currentPathItems).toEqual([retained]);
    expect(store.selectedItems).toEqual([]);

    stream.resolve({ type: 'done', success: true, items: [] });
    await deletion;
    expect(browse).toHaveBeenCalledWith(
      'Volume',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('reconciles the active listing after a rejected deletion', async () => {
    const stream = deferred();
    deleteItemsStream.mockReturnValue(stream.promise);
    browse.mockResolvedValue({ path: 'Volume', items: [removed, retained] });

    const store = useFileStore();
    store.setCurrentPath('Volume');
    store.currentPathItems = [removed, retained];

    const deletion = store.del([removed]);
    await Promise.resolve();
    expect(store.currentPathItems).toEqual([retained]);

    stream.reject(new Error('Deletion denied'));
    await expect(deletion).rejects.toThrow('Deletion denied');
    expect(store.currentPathItems.map((item) => item.name)).toEqual([removed.name, retained.name]);
  });
});
