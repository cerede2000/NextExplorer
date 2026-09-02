import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import SettingsFolderSize from './SettingsFolderSize.vue';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';

/**
 * Both exclusion pages are one component now. What stays here is the part that
 * is genuinely this page's own: folder sizes are switched on by a *mode* that
 * can be several things, not by a boolean, and getting that wrong shows an
 * editable form for a feature that is not running — which is what this page
 * did before it said anything at all.
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
        folderSize: {
          title: 'Folder sizes',
          subtitle: 'Exclude paths.',
          environment: 'From the environment',
          additional: 'Additional',
          none: 'No path configured',
          placeholder: 'Stacks/docker',
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

const mountTab = () => mount(SettingsFolderSize, { global: { plugins: [i18n] } });

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the folder size settings page', () => {
  it.each([['full'], ['shallow']])('takes input when the mode is %s', (mode) => {
    useFeaturesStore().folderSizeMode = mode;

    const wrapper = mountTab();

    expect(wrapper.find('input').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('This feature is not enabled');
  });

  it.each([['off'], [null], [undefined], ['']])(
    'says the feature is off, and how to turn it on, when the mode is %s',
    (mode) => {
      useFeaturesStore().folderSizeMode = mode;

      const wrapper = mountTab();

      expect(wrapper.text()).toContain('This feature is not enabled');
      expect(wrapper.text()).toContain('FOLDER_SIZE_MODE');
      expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    }
  );

  it('reads its own list, not the search index’s', () => {
    useFeaturesStore().folderSizeMode = 'full';
    useAppSettings().systemSettings = {
      folderSize: { excludedPaths: [], environmentExcludedPaths: ['Stacks/docker'] },
      searchIndex: { excludedPaths: [], environmentExcludedPaths: ['Somewhere/else'] },
    };

    const wrapper = mountTab();

    expect(wrapper.text()).toContain('Stacks/docker');
    expect(wrapper.text()).not.toContain('Somewhere/else');
  });
});
