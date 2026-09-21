import { describe, it, expect, beforeEach, vi } from 'vitest';
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
          running: 'Measure folder sizes',
          runningHelp: 'Measures folders in the background.',
          modeOff: 'Off',
          modeShallow: 'Their own files only',
          modeFull: 'Everything inside them',
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
    'says the feature is off, and points at the switch, when the mode is %s',
    (mode) => {
      useFeaturesStore().folderSizeMode = mode;

      const wrapper = mountTab();

      expect(wrapper.text()).toContain('This feature is not enabled');
      expect(wrapper.text()).toContain('Turn it on with the switch above.');
      expect(wrapper.find('input').attributes('disabled')).toBeDefined();
      // Every non-mode reads as off, and the control says so.
      expect(wrapper.find('[data-testid="folder-size-mode"]').element.value).toBe('off');
    }
  );

  it('names the variable, and holds the control still, when the environment chose', () => {
    const features = useFeaturesStore();
    features.folderSizeMode = 'shallow';
    features.folderSizeLockedBy = 'FOLDER_SIZE_MODE';

    const wrapper = mountTab();

    const control = wrapper.find('[data-testid="folder-size-mode"]');
    expect(control.element.value).toBe('shallow');
    expect(control.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="background-switch-locked"]').text()).toContain(
      'FOLDER_SIZE_MODE'
    );
  });

  it('switches to a mode from the page, and the list comes alive', async () => {
    const appSettings = useAppSettings();
    const save = vi.spyOn(appSettings, 'save').mockResolvedValue({});
    useFeaturesStore().folderSizeMode = 'off';

    const wrapper = mountTab();
    await wrapper.find('[data-testid="folder-size-mode"]').setValue('full');

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ folderSize: { mode: 'full' } }));
    await vi.waitFor(() => expect(wrapper.find('input').attributes('disabled')).toBeUndefined());
    expect(useFeaturesStore().folderSizeMode).toBe('full');
  });

  it('offers exactly the three modes, off first', () => {
    useFeaturesStore().folderSizeMode = 'off';
    const wrapper = mountTab();

    const values = wrapper
      .findAll('[data-testid="folder-size-mode"] option')
      .map((o) => o.element.value);
    expect(values).toEqual(['off', 'shallow', 'full']);
  });

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
