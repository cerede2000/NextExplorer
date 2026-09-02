import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppSettings } from './appSettings';
import { useAuthStore } from './auth';

/**
 * A path written into the compose file has to reach the page that shows it.
 *
 * It did not. The server sent `searchIndex` and this store dropped it, because
 * system settings are copied across field by field and the new one was not in
 * the list — so the exclusions page reported "no path configured" for a path
 * that was very much configured. The same shape of omission would silently
 * drop the next one too.
 */
vi.mock('@/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const api = await import('@/api');

describe('system settings that come back from the server', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    useAuthStore().currentUser = { id: 'user-1' };
  });

  it('keeps the search index exclusions, both lists', async () => {
    api.getSettings.mockResolvedValue({
      searchIndex: {
        excludedPaths: ['Photos/RAW'],
        environmentExcludedPaths: ['Stacks/docker'],
      },
      folderSize: { excludedPaths: [], environmentExcludedPaths: ['Stacks/docker'] },
    });

    const appSettings = useAppSettings();
    await appSettings.load('user-1');

    expect(appSettings.systemSettings.searchIndex.environmentExcludedPaths).toEqual([
      'Stacks/docker',
    ]);
    expect(appSettings.systemSettings.searchIndex.excludedPaths).toEqual(['Photos/RAW']);
  });

  it('offers both lists to whatever saves them', async () => {
    api.getSettings.mockResolvedValue({
      searchIndex: { excludedPaths: ['Photos/RAW'], environmentExcludedPaths: [] },
    });

    const appSettings = useAppSettings();
    await appSettings.load('user-1');

    expect(appSettings.state.searchIndex.excludedPaths).toEqual(['Photos/RAW']);
  });

  it('answers with empty lists rather than nothing when the server sends none', async () => {
    api.getSettings.mockResolvedValue({});

    const appSettings = useAppSettings();
    await appSettings.load('user-1');

    expect(appSettings.systemSettings.searchIndex).toEqual({
      excludedPaths: [],
      environmentExcludedPaths: [],
    });
  });
});
