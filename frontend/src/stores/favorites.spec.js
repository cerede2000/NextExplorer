import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The favourites in the sidebar.
 *
 * Small, and read on every render of the sidebar and every folder header, which
 * is why the interesting part is not the requests but what happens to the list
 * around them. Adding an existing path replaces rather than appends, or the
 * sidebar shows the same folder twice with only one of them working. A failed
 * load empties the list rather than leaving a half-loaded one. And `isFavorite`
 * answers from a Set, so it has to be rebuilt whenever the list is — a stale
 * one leaves a star lit on something that is no longer there.
 */

const fetchFavorites = vi.fn();
const addFavoriteRequest = vi.fn();
const removeFavoriteRequest = vi.fn();
const updateFavoriteRequest = vi.fn();
const reorderFavoritesRequest = vi.fn();

vi.mock('@/api', () => ({
  fetchFavorites: (...a) => fetchFavorites(...a),
  addFavorite: (...a) => addFavoriteRequest(...a),
  removeFavorite: (...a) => removeFavoriteRequest(...a),
  updateFavorite: (...a) => updateFavoriteRequest(...a),
  reorderFavorites: (...a) => reorderFavoritesRequest(...a),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));

import { useFavoritesStore } from './favorites';

const favorite = (path, extra = {}) => ({ id: `id-${path}`, path, label: path, ...extra });

beforeEach(() => {
  setActivePinia(createPinia());
  [
    fetchFavorites,
    addFavoriteRequest,
    removeFavoriteRequest,
    updateFavoriteRequest,
    reorderFavoritesRequest,
  ].forEach((m) => m.mockReset());
  fetchFavorites.mockResolvedValue([favorite('Docs'), favorite('Media/Photos')]);
});

describe('loading', () => {
  it('fills the list and marks itself loaded', async () => {
    const store = useFavoritesStore();

    await store.loadFavorites();

    expect(store.favorites).toHaveLength(2);
    expect(store.hasLoaded).toBe(true);
    expect(store.isLoading).toBe(false);
  });

  /**
   * A failed reload must not leave the previous list showing. Starting from a
   * loaded list is the point: from an empty one the assertion holds whether or
   * not the code clears anything.
   */
  it('empties a populated list and keeps the error when a reload fails', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    expect(store.favorites).toHaveLength(2);

    fetchFavorites.mockRejectedValue(new Error('offline'));
    store.hasLoaded = false;
    await store.loadFavorites();

    expect(store.favorites).toEqual([]);
    expect(store.lastError?.message).toBe('offline');
    expect(store.hasLoaded).toBe(true);
  });

  it('clears a previous error on the next successful load', async () => {
    fetchFavorites.mockRejectedValueOnce(new Error('offline'));
    const store = useFavoritesStore();
    await store.loadFavorites();

    fetchFavorites.mockResolvedValue([favorite('Docs')]);
    await store.loadFavorites();

    expect(store.lastError).toBeNull();
  });

  it('treats a response that is not a list as an empty one', async () => {
    fetchFavorites.mockResolvedValue({ items: [] });
    const store = useFavoritesStore();

    await store.loadFavorites();

    expect(store.favorites).toEqual([]);
  });

  it('does not start a second load while one is running', async () => {
    let release;
    fetchFavorites.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const store = useFavoritesStore();

    const first = store.loadFavorites();
    await store.loadFavorites();
    release([favorite('Docs')]);
    await first;

    expect(fetchFavorites).toHaveBeenCalledTimes(1);
  });

  it('ensureLoaded asks once and then never again', async () => {
    const store = useFavoritesStore();

    await store.ensureLoaded();
    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(fetchFavorites).toHaveBeenCalledTimes(1);
  });

  /** Failing counts as loaded: retrying on every render would hammer a down server. */
  it('ensureLoaded does not retry after a failure', async () => {
    fetchFavorites.mockRejectedValue(new Error('offline'));
    const store = useFavoritesStore();

    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(fetchFavorites).toHaveBeenCalledTimes(1);
  });
});

describe('asking whether a path is one', () => {
  it('answers from the loaded list', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();

    expect(store.isFavorite('Docs')).toBe(true);
    expect(store.isFavorite('Media/Photos')).toBe(true);
    expect(store.isFavorite('Elsewhere')).toBe(false);
  });

  it('normalises the path first, so a stray slash still matches', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();

    expect(store.isFavorite('/Docs/')).toBe(true);
  });

  it('says no to an empty path rather than matching the root', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();

    expect(store.isFavorite('')).toBe(false);
    expect(store.isFavorite(null)).toBe(false);
  });

  /** The lookup Set is derived, so it has to follow the list rather than lag it. */
  it('follows the list when it changes', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    removeFavoriteRequest.mockResolvedValue(null);

    await store.removeFavorite('Docs');

    expect(store.isFavorite('Docs')).toBe(false);
  });
});

describe('adding one', () => {
  it('appends what the server gave back', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    addFavoriteRequest.mockResolvedValue(favorite('Archive', { label: 'Archive 2026' }));

    const added = await store.addFavorite({ path: 'Archive', label: 'Archive 2026' });

    expect(store.favorites).toHaveLength(3);
    expect(added.label).toBe('Archive 2026');
  });

  /**
   * Adding a path that is already there is a relabel, not a second entry — two
   * rows for one folder in the sidebar, of which only one does anything.
   */
  it('replaces an entry for a path already favourited', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    addFavoriteRequest.mockResolvedValue(favorite('Docs', { label: 'Documents' }));

    await store.addFavorite({ path: 'Docs', label: 'Documents' });

    expect(store.favorites).toHaveLength(2);
    expect(store.favorites.find((f) => f.path === 'Docs').label).toBe('Documents');
  });

  it('replaces by id as well as by path', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    addFavoriteRequest.mockResolvedValue({ id: 'id-Docs', path: 'Docs/Moved', label: 'Moved' });

    await store.addFavorite({ path: 'Docs/Moved' });

    expect(store.favorites).toHaveLength(2);
  });

  it('normalises the path it sends', async () => {
    const store = useFavoritesStore();
    addFavoriteRequest.mockResolvedValue(favorite('Docs'));

    await store.addFavorite({ path: '/Docs/' });

    expect(addFavoriteRequest).toHaveBeenCalledWith('Docs', expect.anything());
  });

  it('refuses a path that normalises away to nothing', async () => {
    const store = useFavoritesStore();

    await expect(store.addFavorite({ path: '///' })).rejects.toThrow(/valid path/i);
    expect(addFavoriteRequest).not.toHaveBeenCalled();
  });

  /** A server that answers with nothing must still leave a usable entry. */
  it('builds an entry itself when the server returns nothing useful', async () => {
    const store = useFavoritesStore();
    addFavoriteRequest.mockResolvedValue(null);

    const added = await store.addFavorite({ path: 'Archive', label: 'A' });

    expect(added).toMatchObject({ path: 'Archive', label: 'A' });
    expect(store.favorites).toHaveLength(1);
  });
});

describe('removing one', () => {
  it('drops it from the list', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    removeFavoriteRequest.mockResolvedValue(null);

    await store.removeFavorite('Docs');

    expect(store.favorites.map((f) => f.path)).toEqual(['Media/Photos']);
  });

  /** A server that returns the whole list is authoritative; take it. */
  it('takes the server’s list when it sends one', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    removeFavoriteRequest.mockResolvedValue([favorite('Only')]);

    await store.removeFavorite('Docs');

    expect(store.favorites.map((f) => f.path)).toEqual(['Only']);
  });

  it('normalises the path first', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    removeFavoriteRequest.mockResolvedValue(null);

    await store.removeFavorite('/Docs/');

    expect(removeFavoriteRequest).toHaveBeenCalledWith('Docs');
  });

  it('refuses an empty path rather than removing something arbitrary', async () => {
    const store = useFavoritesStore();

    await expect(store.removeFavorite('')).rejects.toThrow(/valid path/i);
    expect(removeFavoriteRequest).not.toHaveBeenCalled();
  });
});

describe('renaming one', () => {
  it('replaces the entry in place, keeping its position', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    updateFavoriteRequest.mockResolvedValue(favorite('Docs', { label: 'Renamed' }));

    await store.updateFavorite('id-Docs', { label: 'Renamed' });

    expect(store.favorites[0].label).toBe('Renamed');
    expect(store.favorites).toHaveLength(2);
  });

  it('refuses without an id', async () => {
    const store = useFavoritesStore();

    await expect(store.updateFavorite('', { label: 'x' })).rejects.toThrow(/valid favorite id/i);
    expect(updateFavoriteRequest).not.toHaveBeenCalled();
  });

  it('sends an empty object rather than undefined when given no changes', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    updateFavoriteRequest.mockResolvedValue(favorite('Docs'));

    await store.updateFavorite('id-Docs');

    expect(updateFavoriteRequest).toHaveBeenCalledWith('id-Docs', {});
  });
});

describe('reordering', () => {
  it('takes the order the server confirms', async () => {
    const store = useFavoritesStore();
    await store.loadFavorites();
    reorderFavoritesRequest.mockResolvedValue([favorite('Media/Photos'), favorite('Docs')]);

    await store.reorderFavorites(['id-Media/Photos', 'id-Docs']);

    expect(store.favorites.map((f) => f.path)).toEqual(['Media/Photos', 'Docs']);
  });
});
