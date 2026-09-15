import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The name and logo everybody sees: on the sign-in page before anyone has signed
 * in, and in the header afterwards.
 *
 * A chosen logo is only shown on this page until Save. It used to be uploaded
 * the moment it was chosen, over the logo in use and under the one name its
 * type had: Discard could not bring the old logo back, and a PNG chosen over a
 * PNG came back at the same address, so the page offered nothing to save. Save
 * now sends the logo with the rest of the branding in one request, which the
 * server stores whole or not at all. A file that cannot serve as a logo is
 * refused before it is ever shown.
 */

let appSettings;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsBranding from './SettingsBranding.vue';

const STORED = {
  appName: 'Chez Benjy',
  appLogoUrl: '/static/logos/logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e.png',
  showPoweredBy: true,
};
const UPLOADED = '/static/logos/logo-9a8e1f2a-3b4c-4d6e-8b7f-7c1e3d444c55.png';
const TWO_MB = 2 * 1024 * 1024;

let wrapper;
let previews;

const open = async (branding = STORED) => {
  appSettings = reactive({
    state: { branding },
    save: vi.fn(async (partial) => {
      appSettings.state.branding = { ...appSettings.state.branding, ...partial.branding };
    }),
    saveLogo: vi.fn(async (_file, fields) => {
      appSettings.state.branding = {
        ...appSettings.state.branding,
        ...fields,
        appLogoUrl: UPLOADED,
      };
    }),
  });
  wrapper = mount(SettingsBranding);
  await flushPromises();
  return wrapper;
};

const logoFile = (name, type, size = 128) => new File([new Uint8Array(size)], name, { type });

const chooseLogo = async (file) => {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
};

const nameField = () => wrapper.get('input[type="text"]');
const poweredBy = () => wrapper.get('input[type="checkbox"]');
const logoShown = () => wrapper.get('img').attributes('src');
const button = (label) => wrapper.findAll('button').find((item) => item.text() === label);
const saveButton = () => wrapper.find('[data-test="branding-save"]');
const removeLogoButton = () =>
  wrapper.findAll('button').find((item) => item.attributes('title') === 'common.remove');

const save = async () => {
  await saveButton().trigger('click');
  await flushPromises();
};

beforeEach(() => {
  previews = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:preview-${++previews}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
});

describe('the branding settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open();

    expect(nameField().element.value).toBe('Chez Benjy');
    expect(poweredBy().element.checked).toBe(true);
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(saveButton().exists()).toBe(false);
  });

  it('save the name and the footer link as edited, with the stored logo, and confirm it', async () => {
    await open();

    await nameField().setValue('Files');
    await poweredBy().setValue(false);
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(appSettings.save).toHaveBeenCalledWith({
      branding: { appName: 'Files', appLogoUrl: STORED.appLogoUrl, showPoweredBy: false },
    });
    expect(appSettings.saveLogo).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.branding.saved');
    expect(saveButton().exists()).toBe(false);
  });

  it.each([[''], ['   ']])(
    'refuse an application name of %j before anything is sent',
    async (typed) => {
      await open();

      await nameField().setValue(typed);

      expect(wrapper.get('[data-test="branding-name-invalid"]').text()).toBe(
        'settings.branding.appNameRequired'
      );
      expect(saveButton().attributes('disabled')).toBeDefined();
      await saveButton().trigger('click');
      await flushPromises();
      expect(appSettings.save).not.toHaveBeenCalled();
    }
  );

  it('report a save the server refused, and keep the edits on screen', async () => {
    await open();
    appSettings.save.mockRejectedValueOnce(new Error('Admin access required'));

    await nameField().setValue('Files');
    await save();

    expect(wrapper.text()).toContain(
      'settings.branding.saveFailed {"reason":"Admin access required"}'
    );
    expect(nameField().element.value).toBe('Files');
    expect(saveButton().exists()).toBe(true);
  });
});

describe('a new logo', () => {
  it('is only shown when chosen: nothing is sent until Save', async () => {
    await open();

    await chooseLogo(logoFile('logo.svg', 'image/svg+xml'));

    expect(logoShown()).toBe('blob:preview-1');
    expect(wrapper.text()).toContain('settings.branding.logoSelected');
    expect(appSettings.saveLogo).not.toHaveBeenCalled();
    expect(appSettings.save).not.toHaveBeenCalled();
  });

  it('chosen over a logo of the same type is still a change to save', async () => {
    await open();

    await chooseLogo(logoFile('another.png', 'image/png'));

    expect(saveButton().exists()).toBe(true);
    expect(saveButton().attributes('disabled')).toBeUndefined();
  });

  it('is forgotten on Discard, which brings back the stored logo having sent nothing', async () => {
    await open();

    await nameField().setValue('Files');
    await chooseLogo(logoFile('logo.svg', 'image/svg+xml'));
    await button('common.discard').trigger('click');

    expect(nameField().element.value).toBe('Chez Benjy');
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(saveButton().exists()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(appSettings.save).not.toHaveBeenCalled();
    expect(appSettings.saveLogo).not.toHaveBeenCalled();
  });

  it('is saved with the rest of the branding in one request, and then shown from the server', async () => {
    await open();
    const file = logoFile('logo.png', 'image/png');

    await nameField().setValue('Files');
    await chooseLogo(file);
    await save();

    expect(appSettings.saveLogo).toHaveBeenCalledTimes(1);
    expect(appSettings.saveLogo).toHaveBeenCalledWith(file, {
      appName: 'Files',
      showPoweredBy: true,
    });
    expect(appSettings.save).not.toHaveBeenCalled();
    expect(logoShown()).toBe(UPLOADED);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(saveButton().exists()).toBe(false);
    expect(wrapper.text()).toContain('settings.branding.saved');
  });

  it('cannot be saved twice at once', async () => {
    await open();
    let settle;
    appSettings.saveLogo.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));

    await chooseLogo(logoFile('logo.png', 'image/png'));
    await saveButton().trigger('click');
    await flushPromises();

    expect(saveButton().attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="branding-choose-logo"]').attributes('disabled')).toBeDefined();
    await saveButton().trigger('click');
    expect(appSettings.saveLogo).toHaveBeenCalledTimes(1);

    settle();
    await flushPromises();
  });

  it('that the server refused stays chosen, with the edits, and the reason is shown', async () => {
    await open();
    appSettings.saveLogo.mockRejectedValueOnce(new Error('A logo can be at most 2 MB.'));

    await nameField().setValue('Files');
    await chooseLogo(logoFile('logo.png', 'image/png'));
    await save();

    expect(wrapper.text()).toContain(
      'settings.branding.saveFailed {"reason":"A logo can be at most 2 MB."}'
    );
    expect(logoShown()).toBe('blob:preview-1');
    expect(nameField().element.value).toBe('Files');
    expect(saveButton().attributes('disabled')).toBeUndefined();
  });

  it('chosen again replaces the first choice, whose preview is released', async () => {
    await open();

    await chooseLogo(logoFile('first.png', 'image/png'));
    await chooseLogo(logoFile('second.png', 'image/png'));

    expect(logoShown()).toBe('blob:preview-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('is refused before it is shown when it is larger than 2 MB', async () => {
    await open();

    await chooseLogo(logoFile('huge.png', 'image/png', TWO_MB + 1));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.branding.logoError');
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(saveButton().exists()).toBe(false);
  });

  it('is accepted at exactly 2 MB', async () => {
    await open();

    await chooseLogo(logoFile('exact.png', 'image/png', TWO_MB));

    expect(logoShown()).toBe('blob:preview-1');
  });

  it('is refused before it is shown when it is not an SVG, PNG or JPEG image', async () => {
    await open();

    await chooseLogo(logoFile('logo.gif', 'image/gif'));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.branding.invalidFileType');
    expect(logoShown()).toBe(STORED.appLogoUrl);
  });

  it('is released when the page is left without saving', async () => {
    await open();

    await chooseLogo(logoFile('logo.png', 'image/png'));
    wrapper.unmount();
    wrapper = null;

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });
});

describe('removing the custom logo', () => {
  it('goes back to the default logo, which is what is then saved', async () => {
    await open();

    await removeLogoButton().trigger('click');

    expect(logoShown()).toBe('/logo.svg');
    expect(removeLogoButton()).toBeUndefined();

    await save();

    expect(appSettings.save.mock.calls[0][0].branding.appLogoUrl).toBe('/logo.svg');
    expect(appSettings.saveLogo).not.toHaveBeenCalled();
  });

  it('also drops a logo chosen and not saved', async () => {
    await open();

    await chooseLogo(logoFile('logo.png', 'image/png'));
    await removeLogoButton().trigger('click');

    expect(logoShown()).toBe('/logo.svg');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });
});
