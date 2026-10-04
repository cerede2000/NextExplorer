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
// The address is where the chosen theme is written, and where a link to one
// arrives.
const routing = { hash: '' };
const replace = vi.fn((to) => {
  routing.hash = to.hash;
});
vi.mock('vue-router', () => ({
  useRoute: () => routing,
  useRouter: () => ({ replace }),
}));
// A fixed set, so the list on the page does not change with the translations
// that happen to be shipped.
vi.mock('@/i18n', () => ({
  supportedLocaleOptions: [{ code: 'en' }, { code: 'fr' }, { code: 'nl' }],
  languageLabel: (code) => ({ en: 'English', fr: 'Français', nl: 'Nederlands' })[code] || code,
}));

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
  foldersFirst: false,
  markdownOpensInEditor: true,
  documentsOpenInNewTab: true,
  downloadMode: 'separate',
  // On in what is stored, so the payload below proves the stored value is
  // carried through rather than a default being resent.
  browseInTabs: true,
  closeTabsOnDoubleClick: true,
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

/**
 * Each switch, by the name the page tags it with.
 *
 * It used to be a list read by *position* — the nth switch on the screen —
 * which is a selector that silently points at a different preference the moment
 * anything is grouped, moved or hidden. The names are the page's own, and the
 * browser journey reaches them the same way.
 */
const SWITCHES = {
  showHiddenFiles: 'show-hidden-files',
  showThumbnails: 'show-thumbnails',
  markdownOpensInEditor: 'markdown-opens-in-editor',
  documentsOpenInNewTab: 'documents-in-new-tab',
  browseInTabs: 'browse-in-tabs',
  closeTabsOnDoubleClick: 'close-tabs-on-double-click',
  reopenTabs: 'reopen-tabs',
  preloadBackgroundTabs: 'preload-background-tabs',
  showVersionMarks: 'show-version-marks',
  showSidebarFavorites: 'show-sidebar-favorites',
  showSidebarShares: 'show-sidebar-shares',
  showSidebarTools: 'show-sidebar-tools',
  foldersFirst: 'folders-first',
  quickActions: 'quick-actions',
};

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

const jumpTo = (name) => wrapper.get(`[data-test="preferences-jump-${name}"]`);
const rowLabels = () => wrapper.findAll('section .font-medium').map((row) => row.text());
const sectionTitles = () => wrapper.findAll('section h3').map((title) => title.text());
const indexTitles = () =>
  wrapper.findAll('[data-test^="preferences-jump-"]').map((entry) => entry.text());
const typeInFilter = async (text) => {
  await wrapper.get('[data-test="preferences-filter"]').setValue(text);
};

const toggle = (name) => wrapper.get(`[data-test="${SWITCHES[name]}"]`);
const expiryField = () => wrapper.get('input[type="number"]');
const select = (name) => wrapper.get(`[data-test="preferences-${name}"]`);
const unitSelect = () => select('expiry-unit');
const viewSelect = () => select('default-view');
const startSelect = () => select('start');
const languageSelect = () => select('language');
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
  routing.hash = '';
  replace.mockClear();
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

  it('start with the versions mark on, as the server reads its absence', async () => {
    // The server reads this one as `!== false`, so a client default of off
    // would show a switch that disagrees with what the listings are doing —
    // and turning it on would save nothing, because nothing changed.
    await open(DEFAULTS);

    expect(toggle('showVersionMarks').attributes('aria-checked')).toBe('true');
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
        // Carried through as stored: off here, and the default is on.
        foldersFirst: false,
        markdownOpensInEditor: true,
        documentsOpenInNewTab: true,
        showVersionMarks: true,
        locale: null,
        downloadMode: 'separate',
        browseInTabs: true,
        closeTabsOnDoubleClick: true,
        // Off unless it is turned on, which is what makes keeping a tab mean
        // something: with everything coming back, "kept" says nothing that "open"
        // does not already say.
        reopenTabs: false,
        // On unless it is turned off: a tab opened in the background is opened in
        // order not to wait for it.
        preloadBackgroundTabs: true,
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

/**
 * The language this account reads in.
 *
 * The only other way to choose one is the picker on the sign-in page, which
 * writes into the browser and is never seen again once somebody is signed in —
 * so it could not be found at all (nxzai/NextExplorer discussion #408). This
 * one belongs to the account and travels with it.
 */
describe('the language', () => {
  it('follows the browser until somebody chooses', async () => {
    await open(DEFAULTS);

    expect(selected(languageSelect())).toBe('i18n.followBrowser');
    expect(button('common.save')).toBeUndefined();
  });

  it('shows the chosen one named in itself, not in the language of the page', async () => {
    await open({ ...STORED, locale: 'nl' });

    expect(selected(languageSelect())).toBe('Nederlands');
    expect(button('common.save')).toBeUndefined();
  });

  it('is saved with the other preferences', async () => {
    await open();

    await choose(languageSelect(), 'Français');
    await save();

    expect(sentUser().locale).toBe('fr');
  });

  it('is handed back as nothing when the browser is followed again', async () => {
    await open({ ...STORED, locale: 'fr' });

    await choose(languageSelect(), 'i18n.followBrowser');
    await save();

    expect(sentUser().locale).toBeNull();
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

/**
 * Twenty preferences in one unbroken column asked anybody looking for one of
 * them to read all twenty. They are grouped by theme now, with a list of the
 * themes beside them.
 */
describe('finding one preference among twenty', () => {
  it('draws every theme, in the order the index lists them', async () => {
    await open();

    expect(sectionTitles()).toEqual([
      'settings.userPreferences.sections.display',
      'settings.userPreferences.sections.documents',
      'settings.userPreferences.sections.tabs',
      'settings.userPreferences.sections.sidebar',
      'settings.userPreferences.sections.start',
      'settings.userPreferences.sections.transfers',
      'settings.userPreferences.sections.quickActions',
    ]);
    // Read as well as listed: an index in one order over sections in another
    // is a list that sends people to the wrong place and reads as if it did
    // not.
    expect(indexTitles()).toEqual(sectionTitles());
  });

  /** A theme the filter has hidden is not somewhere to be sent. */
  it('goes nowhere for a theme that is not on screen', async () => {
    await open();
    await typeInFilter('thumbnail');

    await jumpTo('tabs').trigger('click');

    expect(replace).not.toHaveBeenCalled();
  });

  /** And says so, rather than leaving a row of entries that do nothing. */
  it('puts out the themes the filter has emptied', async () => {
    await open();

    await typeInFilter('thumbnail');

    expect(jumpTo('tabs').attributes('disabled')).toBeDefined();
    expect(jumpTo('display').attributes('disabled')).toBeUndefined();
  });

  /** Nor does it go on pointing at a theme that is no longer there. */
  it('drops the mark on a chosen theme the filter has emptied', async () => {
    await open();
    await jumpTo('tabs').trigger('click');

    await typeInFilter('thumbnail');

    expect(wrapper.findAll('[aria-current="true"]')).toHaveLength(0);
  });

  /** So the page somebody is looking at is the page they can send. */
  it('writes the chosen theme into the address', async () => {
    await open();

    await jumpTo('tabs').trigger('click');

    expect(replace).toHaveBeenCalledWith({ hash: '#tabs' });
    expect(jumpTo('tabs').attributes('aria-current')).toBe('true');
  });

  it('opens on the theme an address names', async () => {
    routing.hash = '#transfers';

    await open();

    expect(jumpTo('transfers').attributes('aria-current')).toBe('true');
    // Arriving somewhere is not choosing it again: the address already says so.
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores a theme nothing on this page is called', async () => {
    routing.hash = '#whatever-this-is';

    await open();

    expect(wrapper.findAll('[aria-current="true"]')).toHaveLength(0);
    expect(sectionTitles()).toHaveLength(7);
  });

  it('narrows to the preferences whose words match', async () => {
    await open();

    await typeInFilter('thumbnail');

    expect(sectionTitles()).toEqual(['settings.userPreferences.sections.display']);
    expect(rowLabels()).toEqual(['settings.userPreferences.showThumbnails']);
  });

  /**
   * Matched against what a row shows, in the reader's own language, and folded
   * the way the folder's own typeahead folds a key — which is where stripping
   * the accents is proven, so that a French reader looking for
   * "telechargement" finds "téléchargement". Here what is proven is that this
   * screen folds at all: a reader typing in capitals is not told there is no
   * such preference.
   */
  it('matches however it was typed', async () => {
    await open();

    await typeInFilter('THUMBNAIL');

    expect(rowLabels()).toEqual(['settings.userPreferences.showThumbnails']);
  });

  it('says so when nothing matches, rather than drawing an empty page', async () => {
    await open();

    await typeInFilter('xylophone');

    expect(sectionTitles()).toEqual([]);
    expect(wrapper.get('[data-test="preferences-no-match"]').text()).toContain('xylophone');
  });

  it('gives everything back when the filter is emptied', async () => {
    await open();
    await typeInFilter('thumbnail');

    await typeInFilter('');

    expect(sectionTitles()).toHaveLength(7);
  });
});

/**
 * Discarding has to put back *every* preference.
 *
 * It was written out by hand beside the three other places that read the same
 * list, and it was three preferences short — so discarding a change to any of
 * those three discarded nothing: the switch stayed where it had been put, the
 * bar kept saying there was something to save, and the next save wrote it.
 */
describe('discarding', () => {
  it.each([['reopenTabs'], ['preloadBackgroundTabs'], ['closeTabsOnDoubleClick']])(
    'puts %s back the way it was stored',
    async (name) => {
      await open();
      const before = toggle(name).attributes('aria-checked');

      await toggle(name).trigger('click');
      expect(toggle(name).attributes('aria-checked')).not.toBe(before);
      await button('common.discard').trigger('click');

      expect(toggle(name).attributes('aria-checked')).toBe(before);
      expect(button('common.save')).toBeUndefined();
      expect(appSettings.save).not.toHaveBeenCalled();
    }
  );
});
