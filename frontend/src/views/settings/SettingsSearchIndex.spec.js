import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import SettingsSearchIndex from './SettingsSearchIndex.vue';
import { useFeaturesStore } from '@/stores/features';

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
      common: { add: 'Add', delete: 'Delete', save: 'Save', discard: 'Discard', unsavedChanges: '' },
      settings: {
        searchIndex: {
          title: 'Search index',
          subtitle: 'Exclude paths.',
          environment: 'From the environment',
          additional: 'Additional',
          none: 'No path configured',
          placeholder: 'Backups/2024',
        },
        featureOff: {
          title: 'This feature is not enabled',
          howTo: 'To turn it on, set {setting} and restart the container.',
          kept: 'What you configure here is saved.',
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
  it('says the feature is off, and how to turn it on', () => {
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    expect(wrapper.find('[data-testid="feature-off-notice"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('SEARCH_INDEX=true');
  });

  it('blocks the form while the feature is off', () => {
    useFeaturesStore().searchIndexEnabled = false;
    const wrapper = mountTab();

    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(
      true
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
