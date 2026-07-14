import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

const browse = vi.fn();
const browseShare = vi.fn();

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  browseShare: (...args) => browseShare(...args),
  normalizePath: (path = '') => String(path).replace(/^\/+|\/+$/g, ''),
  copyItems: vi.fn(),
  moveItems: vi.fn(),
  deleteItems: vi.fn(),
  createFolder: vi.fn(),
  renameItem: vi.fn(),
  saveFileContent: vi.fn(),
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
  useFavoritesStore: () => ({ loadFavorites: vi.fn() }),
}));

vi.mock('@vueuse/core', () => ({
  useStorage: (_key, initialValue) => ref(initialValue),
}));

import { useFileStore } from './fileStore';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('fileStore folder navigation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    browse.mockReset();
    browseShare.mockReset();
  });

  it('keeps the newest listing when a previous folder response arrives late', async () => {
    const first = deferred();
    browse
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        path: 'Volume/Child',
        items: [{ name: 'inside.txt', path: 'Volume/Child', kind: 'file' }],
      });

    const store = useFileStore();
    const rootRequest = store.fetchPathItems('Volume');
    const childRequest = store.fetchPathItems('Volume/Child');

    await childRequest;
    first.resolve({
      path: 'Volume',
      items: [{ name: 'Child', path: 'Volume', kind: 'directory' }],
    });
    await rootRequest;

    expect(browse.mock.calls[0][1].signal.aborted).toBe(true);
    expect(store.currentPath).toBe('Volume/Child');
    expect(store.currentPathItems).toEqual([
      { name: 'inside.txt', path: 'Volume/Child', kind: 'file' },
    ]);
  });
});
