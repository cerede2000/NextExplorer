import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * A person's own preferences: what the explorer shows them, how a folder opens,
 * how long their shares last unless they say otherwise.
 *
 * Saving sends the whole list, so every preference the person did not touch is
 * sent too, and has to be sent as it is stored: one read back wrong is silently
 * overwritten the next time any other switch on this page is saved. The
 * per-folder sorts and views are not part of that list; they are saved one
 * folder at a time and are not this page's to send.
 */

let appSettings;
let features;
let quickActions;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/quickActions', () => ({ useQuickActionsStore: () => quickActions }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsUserPreferences from './SettingsUserPreferences.vue';

const STORED = {
  showHiddenFiles: false,
  showThumbnails: true,
  showSidebarFavorites: true,
  showSidebarShares: false,
  showSidebarTools: true,
  defaultShareExpiration: { value: 2, unit: 'weeks' },
  skipHome: false,
  folderSorts: { Docs: { by: 'name', order: 'asc', updatedAt: 1 } },
  folderViews: { Photos: { mode: 'photos', updatedAt: 1 } },
  defaultView: 'list',
  markdownOpensInEditor: true,
};

/** As the store holds them for somebody who never chose anything. */
const DEFAULTS = {
  showHiddenFiles: false,
  showThumbnails: true,
  showSidebarFavorites: true,
  showSidebarShares: true,
  showSidebarTools: true,
  defaultShareExpiration: null,
  skipHome: null,
  folderSorts: {},
  folderViews: {},
  defaultView: null,
  markdownOpensInEditor: false,
};

const SWITCHES = [
  'showHiddenFiles',
  'showThumbnails',
  'markdownOpensInEditor',
  'showSidebarFavorites',
  'showSidebarShares',
  'showSidebarTools',
  'quickActions',
];

let wrapper;

const open = async (user = STORED) => {
  appSettings = reactive({
    userSettings: user,
    save: vi.fn(async (partial) => {
      appSettings.userSettings = { ...appSettings.userSettings, ...partial.user };
    }),
  });
  features = reactive({ hiddenFilePatterns: ['.'], ensureLoaded: vi.fn() });
  quickActions = reactive({
    enabled: false,
    displayMode: 'full',
    config: [{ id: 'info', on: true }],
    setEnabled: vi.fn((value) => {
      quickActions.enabled = value;
    }),
    setDisplayMode: vi.fn(),
    setActionOn: vi.fn(),
    move: vi.fn(),
    reset: vi.fn(),
  });
  wrapper = mount(SettingsUserPreferences);
  await flushPromises();
  return wrapper;
};

const toggle = (name) => wrapper.findAll('[role="switch"]')[SWITCHES.indexOf(name)];
const expiryField = () => wrapper.get('input[type="number"]');
const unitSelect = () => wrapper.findAll('select')[0];
const viewSelect = () => wrapper.findAll('select')[1];
const startSelect = () => wrapper.findAll('select')[2];
const selected = (select) =>
  select.element.options[select.element.selectedIndex].textContent.trim();
const choose = (select, label) =>
  select
    .findAll('option')
    .find((option) => option.text() === label)
    .setSelected();
const button = (label) => wrapper.findAll('button').find((item) => item.text() === label);
const sentUser = () => appSettings.save.mock.calls[0][0].user;

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

afterEach(() => {
  wrapper?.unmount();
});

describe('the preferences', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open();

    expect(toggle('showSidebarShares').attributes('aria-checked')).toBe('false');
    expect(toggle('markdownOpensInEditor').attributes('aria-checked')).toBe('true');
    expect(expiryField().element.value).toBe('2');
    expect(unitSelect().element.value).toBe('weeks');
    expect(selected(viewSelect())).toBe('settings.userPreferences.viewList');
    expect(selected(startSelect())).toBe('common.disabled');
    expect(button('common.save')).toBeUndefined();
    expect(features.ensureLoaded).toHaveBeenCalled();
  });

  it('have nothing to save for somebody who never chose anything', async () => {
    await open(DEFAULTS);

    expect(expiryField().element.value).toBe('');
    expect(selected(viewSelect())).toBe('settings.userPreferences.viewGrid');
    expect(selected(startSelect())).toBe('settings.userPreferences.useEnvSetting');
    expect(button('common.save')).toBeUndefined();
  });

  it('save one changed preference with every other one exactly as stored', async () => {
    await open();

    await toggle('showHiddenFiles').trigger('click');
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(appSettings.save).toHaveBeenCalledWith({
      user: {
        showHiddenFiles: true,
        showThumbnails: true,
        showSidebarFavorites: true,
        showSidebarShares: false,
        showSidebarTools: true,
        defaultShareExpiration: { value: 2, unit: 'weeks' },
        skipHome: false,
        defaultView: 'list',
        markdownOpensInEditor: true,
      },
    });
    expect(sentUser()).not.toHaveProperty('folderSorts');
    expect(sentUser()).not.toHaveProperty('folderViews');
    expect(button('common.save')).toBeUndefined();
  });

  it('send a default share expiry as a number with its unit', async () => {
    await open(DEFAULTS);

    await expiryField().setValue('5');
    await unitSelect().setValue('days');
    await save();

    expect(sentUser().defaultShareExpiration).toEqual({ value: 5, unit: 'days' });
  });

  it('send no default share expiry once it has been cleared', async () => {
    await open();

    await wrapper
      .findAll('button')
      .find((item) => item.attributes('title') === 'common.clear')
      .trigger('click');
    expect(expiryField().element.value).toBe('');
    await save();

    expect(sentUser().defaultShareExpiration).toBeNull();
  });

  /**
   * Minus three weeks was sent as it was, and the server stored it as no
   * default: the default the person had was gone, and the field came back
   * empty.
   */
  it.each([['-3'], ['0'], ['1.5']])(
    'refuse a default share expiry of %s before anything is sent',
    async (typed) => {
      await open();

      await expiryField().setValue(typed);

      expect(wrapper.get('[data-test="expiration-invalid"]').text()).toBe(
        'settings.userPreferences.defaultShareExpirationInvalid'
      );
      const saveButton = wrapper.get('[data-test="preferences-save"]');
      expect(saveButton.attributes('disabled')).toBeDefined();
      await saveButton.trigger('click');
      await flushPromises();
      expect(appSettings.save).not.toHaveBeenCalled();
    }
  );

  it('take an emptied expiry field as no default, which is not an error', async () => {
    await open();

    await expiryField().setValue('');

    expect(wrapper.find('[data-test="expiration-invalid"]').exists()).toBe(false);
    await save();
    expect(sentUser().defaultShareExpiration).toBeNull();
  });

  it('send the chosen view and start page as the values they stand for, not as text', async () => {
    await open(DEFAULTS);

    await choose(viewSelect(), 'settings.userPreferences.viewPhotos');
    await choose(startSelect(), 'common.enabled');
    await save();

    expect(sentUser().defaultView).toBe('photos');
    expect(sentUser().skipHome).toBe(true);
  });

  it('send null for the built-in view and for a start page left to the server', async () => {
    await open();

    await choose(viewSelect(), 'settings.userPreferences.viewGrid');
    await choose(startSelect(), 'settings.userPreferences.useEnvSetting');
    await save();

    expect(sentUser().defaultView).toBeNull();
    expect(sentUser().skipHome).toBeNull();
  });

  it('go back to what is stored when the changes are discarded, without sending anything', async () => {
    await open();

    await toggle('showThumbnails').trigger('click');
    await expiryField().setValue('9');
    await choose(viewSelect(), 'settings.userPreferences.viewColumns');
    await button('common.discard').trigger('click');

    expect(toggle('showThumbnails').attributes('aria-checked')).toBe('true');
    expect(expiryField().element.value).toBe('2');
    expect(selected(viewSelect())).toBe('settings.userPreferences.viewList');
    expect(button('common.save')).toBeUndefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});

describe('the quick-actions menu', () => {
  it('is applied straight away in this browser, outside what the page saves', async () => {
    await open();

    await toggle('quickActions').trigger('click');

    expect(quickActions.setEnabled).toHaveBeenCalledWith(true);
    expect(button('common.save')).toBeUndefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});
