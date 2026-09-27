import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

/**
 * What the explorer does when a folder will not load.
 *
 * Every navigation goes through `fetchPathItems`, and its failure paths had no
 * test: a folder that is refused, one that is gone, a request superseded by a
 * faster one, and a stale answer arriving after a newer folder is already on
 * screen. These are the states nobody sees while clicking around and everybody
 * eventually hits — a share that expired mid-session, a permission taken away,
 * a network that dropped between two clicks.
 */

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
  waitForOnlyOfficeActivityVersion: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    sortBy: { by: 'name', order: 'asc' },
    restoreFolderPreferences: vi.fn(),
  }),
}));

vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ thumbnailsEnabledForSession: false }),
}));

vi.mock('@/stores/favorites', () => ({
  useFavoritesStore: () => ({ loadFavorites: vi.fn() }),
}));

vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ onlyofficeEnabled: false, ensureLoaded: async () => {} }),
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

const abortError = () =>
  Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  });

const listing = (path, names) => ({
  path,
  items: names.map((name) => ({ name, path, kind: 'file' })),
});

describe('a folder that will not load', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    browse.mockReset();
    browseShare.mockReset();
  });

  /**
   * The caller is what decides whether to show a message, so the failure has to
   * reach it. Swallowed here, a refused folder would look like an empty one.
   */
  it('hands the failure to the caller rather than showing an empty folder', async () => {
    browse.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    const store = useFileStore();

    await expect(store.fetchPathItems('Private')).rejects.toThrow('Forbidden');
  });

  it('leaves the listing that was on screen rather than blanking it', async () => {
    browse.mockResolvedValueOnce(listing('Volume', ['kept.txt']));
    const store = useFileStore();
    await store.fetchPathItems('Volume');

    browse.mockRejectedValueOnce(new Error('Network down'));
    await expect(store.fetchPathItems('Volume/Gone')).rejects.toThrow('Network down');

    expect(store.currentPathItems.map((item) => item.name)).toEqual(['kept.txt']);
  });

  it('reports a share that has expired mid-session', async () => {
    browseShare.mockRejectedValueOnce(
      Object.assign(new Error('Share has expired'), { status: 403 })
    );
    const store = useFileStore();

    await expect(store.fetchPathItems('share/abc123/photos')).rejects.toThrow('Share has expired');
    expect(browseShare).toHaveBeenCalledWith('abc123', 'photos', expect.anything());
  });
});

describe('a request that a newer one has replaced', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    browse.mockReset();
    browseShare.mockReset();
  });

  /**
   * Clicking quickly through a tree aborts each request as the next starts.
   * Those aborts are the application working, not a failure, and surfacing them
   * would put an error on screen for every fast traversal.
   */
  it('says nothing when an abandoned request is aborted', async () => {
    const first = deferred();
    browse
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(listing('Volume/Child', ['inside.txt']));

    const store = useFileStore();
    const abandoned = store.fetchPathItems('Volume');
    const newest = store.fetchPathItems('Volume/Child');

    await newest;
    first.reject(abortError());

    await expect(abandoned).resolves.toBeNull();
    expect(store.currentPathItems.map((item) => item.name)).toEqual(['inside.txt']);
  });

  /**
   * The other half, and the one that is easy to get wrong: an abort belonging
   * to the *current* request is a real failure — something cancelled the
   * navigation the user is waiting on — and must not be swallowed with the
   * abandoned ones.
   */
  it('still reports an abort on the request nothing has replaced', async () => {
    browse.mockRejectedValueOnce(abortError());
    const store = useFileStore();

    await expect(store.fetchPathItems('Volume')).rejects.toThrow(/aborted/i);
  });

  it('ignores an answer that arrives after a newer folder is on screen', async () => {
    const slow = deferred();
    browse
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(listing('Volume/Child', ['inside.txt']));

    const store = useFileStore();
    const stale = store.fetchPathItems('Volume');
    await store.fetchPathItems('Volume/Child');

    slow.resolve(listing('Volume', ['outdated.txt']));

    await expect(stale).resolves.toBeNull();
    expect(store.currentPath).toBe('Volume/Child');
    expect(store.currentPathItems.map((item) => item.name)).toEqual(['inside.txt']);
  });
});
