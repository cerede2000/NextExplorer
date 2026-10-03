import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * A visitor holding a share link is not asked for what only an account has.
 *
 * They have no favourites and no volumes: the answer is always a refusal. On an
 * ordinary install that refusal is invisible; behind an authentication proxy that
 * lets the share through and nothing else it is a 401, and each one is shown to
 * the reader. Five of them arrive on one page load of a share — three from what
 * every page reads before anybody has done anything, and these two.
 *
 * So they are not asked. Which is also the honest shape: a question whose answer
 * cannot concern the person asking is a question not worth sending.
 */

const fetchFavorites = vi.fn(async () => []);
const getVolumes = vi.fn(async () => []);
vi.mock('@/api', () => ({
  fetchFavorites: (...a) => fetchFavorites(...a),
  getVolumes: (...a) => getVolumes(...a),
  getUsage: vi.fn(async () => ({})),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
  addFavorite: vi.fn(),
  updateFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
  removeFavorite: vi.fn(),
}));

const auth = { isGuest: false };
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({ ensureLoaded: vi.fn(async () => {}), volumeUsageEnabled: false }),
}));

import { useFavoritesStore } from './favorites';
import { useVolumeUsageStore } from './volumeUsage';

beforeEach(() => {
  setActivePinia(createPinia());
  fetchFavorites.mockClear();
  getVolumes.mockClear();
  auth.isGuest = false;
});

describe('what a visitor with no account is not asked', () => {
  it('does not ask a guest for favourites', async () => {
    auth.isGuest = true;

    await useFavoritesStore().loadFavorites();

    expect(fetchFavorites).not.toHaveBeenCalled();
  });

  it('does not ask a guest for volumes', async () => {
    auth.isGuest = true;

    await useVolumeUsageStore().loadVolumes();

    expect(getVolumes).not.toHaveBeenCalled();
  });

  /** And an account is still asked, or the sidebar would be empty for everyone. */
  it('asks an account for both', async () => {
    await useFavoritesStore().loadFavorites();
    await useVolumeUsageStore().loadVolumes();

    expect(fetchFavorites).toHaveBeenCalled();
    expect(getVolumes).toHaveBeenCalled();
  });

  /** A guest is left with the empty answer rather than with nothing loaded. */
  it('leaves a guest with an answer, so nothing waits for one', async () => {
    auth.isGuest = true;
    const favorites = useFavoritesStore();

    await favorites.loadFavorites();

    expect(favorites.favorites).toEqual([]);
    expect(favorites.hasLoaded).toBe(true);
  });
});
