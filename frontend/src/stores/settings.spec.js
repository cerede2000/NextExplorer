import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from './settings';

describe('settings store folder sorting', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('restores each folder sort independently', () => {
    const settings = useSettingsStore();

    settings.restoreSortForFolder('Projects/reports');
    settings.setSort('dateModified', 'desc');

    settings.restoreSortForFolder('Projects/archive');
    expect(settings.sortBy).toMatchObject({ by: 'name', order: 'asc' });

    settings.setSort('size', 'desc');
    settings.restoreSortForFolder('Projects/reports');
    expect(settings.sortBy).toMatchObject({ by: 'dateModified', order: 'desc' });

    settings.restoreSortForFolder('Projects/archive');
    expect(settings.sortBy).toMatchObject({ by: 'size', order: 'desc' });
  });

  it('persists a folder sort for a fresh store instance', async () => {
    const settings = useSettingsStore();

    settings.restoreSortForFolder('Projects/reports');
    settings.setSort('dateModified', 'desc');
    await nextTick();

    setActivePinia(createPinia());
    const reloadedSettings = useSettingsStore();
    reloadedSettings.restoreSortForFolder('Projects/reports');

    expect(reloadedSettings.sortBy).toMatchObject({ by: 'dateModified', order: 'desc' });
  });
});
