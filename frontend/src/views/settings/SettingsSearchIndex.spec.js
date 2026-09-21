import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import SettingsSearchIndex from './SettingsSearchIndex.vue';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';

/**
 * The index is off unless someone asked for it, so this page is more often
 * than not a form for something that is not running. Accepting a list nobody
 * will read, with nothing on the page saying so, is the failure to avoid.
 */
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: {
        add: 'Add',
        delete: 'Delete',
        save: 'Save',
        discard: 'Discard',
        unsavedChanges: '',
      },
      settings: {
        searchIndex: {
          title: 'Search index',
          subtitle: 'Exclude paths.',
          environment: 'From the environment',
          additional: 'Additional',
          none: 'No path configured',
          placeholder: 'Backups/2024',
          running: 'Keep a search index',
          runningHelp: 'Reads the documents in the background.',
        },
        featureOff: {
          title: 'This feature is not enabled',
          howTo: 'To turn it on, set {setting} and restart the container.',
          kept: 'What you configure here is saved.',
          useSwitch: 'Turn it on with the switch above.',
          locked: 'Set by {variable} in the environment.',
        },
      },
    },
  },
});

const mountTab = () => mount(SettingsSearchIndex, { global: { plugins: [i18n] } });

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the search index settings page', () => {
  /**
   * The last link of a chain that broke at three of its four joints: the
   * environment sets a path, the config parses it, the route has to carry it
   * to an administrator, the store has to keep it, and this has to show it.
   * Each of those is now asserted where it lives, because a test one layer
   * below the defect cannot see the defect.
   */
  it('shows the paths the environment set', () => {
    useFeaturesStore().searchIndexEnabled = true;
    useAppSettings().systemSettings.searchIndex = {
      excludedPaths: ['Sauvegardes/2024'],
      environmentExcludedPaths: ['Stacks/docker'],
    };

    const wrapper = mountTab();

    expect(wrapper.text()).toContain('Stacks/docker');
    expect(wrapper.text()).toContain('Sauvegardes/2024');
    expect(wrapper.text()).not.toContain('No path configured');
  });

  it('says so, once, when there is genuinely nothing', () => {
    useFeaturesStore().searchIndexEnabled = true;
    useAppSettings().systemSettings.searchIndex = {
      excludedPaths: [],
      environmentExcludedPaths: [],
    };

    const wrapper = mountTab();

    expect(wrapper.text()).toContain('No path configured');
  });

  it('says the feature is off, and points at the switch that turns it on', () => {
    // The variable used to be the only way in, so the notice named it. With a
    // switch on the page, a file to edit is the long way round (#9).
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    expect(wrapper.find('[data-testid="feature-off-notice"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Turn it on with the switch above.');
    expect(wrapper.text()).not.toContain('SEARCH_INDEX=true');
  });

  it('names the variable when the environment switched it off', () => {
    const features = useFeaturesStore();
    features.searchIndexEnabled = false;
    features.searchIndexLockedBy = 'SEARCH_INDEX';
    const wrapper = mountTab();

    expect(wrapper.text()).toContain('SEARCH_INDEX=true');
    expect(wrapper.find('[data-testid="background-switch-locked"]').text()).toContain(
      'SEARCH_INDEX'
    );
    expect(
      wrapper.find('[data-testid="search-index-switch"]').attributes('disabled')
    ).toBeDefined();
  });

  it('blocks the list while the feature is off, and not the switch', () => {
    // The switch is how it gets turned on, so it is the one control that must
    // stay live on a page for something that is not running.
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    const others = wrapper
      .findAll('button')
      .filter((b) => b.attributes('data-testid') !== 'search-index-switch');
    expect(others.every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(
      wrapper.find('[data-testid="search-index-switch"]').attributes('disabled')
    ).toBeUndefined();
  });

  it('turns the index on from the switch, and the list comes alive', async () => {
    const appSettings = useAppSettings();
    const save = vi.spyOn(appSettings, 'save').mockResolvedValue({});
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    await wrapper.find('[data-testid="search-index-switch"]').trigger('click');
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    expect(save).toHaveBeenCalledWith({ searchIndex: { enabled: true } });
    await vi.waitFor(() => expect(wrapper.find('input').attributes('disabled')).toBeUndefined());
    expect(wrapper.find('[data-testid="feature-off-notice"]').exists()).toBe(false);
  });

  it('leaves the switch where it was when the save is refused', async () => {
    const appSettings = useAppSettings();
    vi.spyOn(appSettings, 'save').mockRejectedValue(new Error('refused'));
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    await wrapper.find('[data-testid="search-index-switch"]').trigger('click');
    await vi.waitFor(() =>
      expect(
        wrapper.find('[data-testid="search-index-switch"]').attributes('disabled')
      ).toBeUndefined()
    );

    expect(useFeaturesStore().searchIndexEnabled).toBe(false);
    expect(wrapper.find('[data-testid="search-index-switch"]').attributes('aria-checked')).toBe(
      'false'
    );
  });

  it('says nothing and takes input once it is on', async () => {
    useFeaturesStore().searchIndexEnabled = true;
    const wrapper = mountTab();

    expect(wrapper.find('[data-testid="feature-off-notice"]').exists()).toBe(false);
    expect(wrapper.find('input').attributes('disabled')).toBeUndefined();

    await wrapper.find('input').setValue('Backups/2024');
    await wrapper.find('input').trigger('keydown.enter');

    expect(wrapper.text()).toContain('Backups/2024');
  });
});
