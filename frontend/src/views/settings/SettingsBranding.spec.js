import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The name and logo everybody sees: on the sign-in page before anyone has signed
 * in, and in the header afterwards.
 *
 * A logo is uploaded the moment it is chosen but only becomes the logo when the
 * page is saved, so what is saved has to be the address the server answered
 * with. A file that cannot serve as a logo is refused before it is sent, and an
 * upload that failed has to say so: the preview would otherwise keep the old
 * logo while the administrator believes the new one is in place.
 */

const fetchMock = vi.fn();
let appSettings;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('@/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsBranding from './SettingsBranding.vue';

const STORED = {
  appName: 'Chez Benjy',
  appLogoUrl: '/static/logos/custom-logo.png',
  showPoweredBy: true,
};
const UPLOADED = '/static/logos/custom-logo.svg';
const TWO_MB = 2 * 1024 * 1024;

let wrapper;
let consoleError;

const open = async (branding = STORED) => {
  appSettings = reactive({
    state: { branding },
    save: vi.fn(async (partial) => {
      appSettings.state.branding = { ...appSettings.state.branding, ...partial.branding };
    }),
  });
  wrapper = mount(SettingsBranding);
  await flushPromises();
  return wrapper;
};

const answer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'Internal Server Error',
  json: async () => body,
});

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
const removeLogoButton = () =>
  wrapper.findAll('button').find((item) => item.attributes('title') === 'common.remove');

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

describe('the branding settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open();

    expect(nameField().element.value).toBe('Chez Benjy');
    expect(poweredBy().element.checked).toBe(true);
    expect(logoShown()).toBe('/static/logos/custom-logo.png');
    expect(button('common.save')).toBeUndefined();
  });

  it('save the name and the footer link as edited, with the stored logo, and confirm it', async () => {
    await open();

    await nameField().setValue('Files');
    await poweredBy().setValue(false);
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(appSettings.save).toHaveBeenCalledWith({
      branding: {
        appName: 'Files',
        appLogoUrl: '/static/logos/custom-logo.png',
        showPoweredBy: false,
      },
    });
    expect(wrapper.text()).toContain('Branding saved successfully!');
    expect(button('common.save')).toBeUndefined();
  });

  it.each([[''], ['   ']])(
    'refuse an application name of %j before anything is sent',
    async (typed) => {
      await open();

      await nameField().setValue(typed);

      expect(wrapper.get('[data-test="branding-name-invalid"]').text()).toBe(
        'settings.branding.appNameRequired'
      );
      const saveButton = wrapper.get('[data-test="branding-save"]');
      expect(saveButton.attributes('disabled')).toBeDefined();
      await saveButton.trigger('click');
      await flushPromises();
      expect(appSettings.save).not.toHaveBeenCalled();
    }
  );

  it('report a save the server refused, and keep the edits on screen', async () => {
    await open();
    appSettings.save.mockRejectedValueOnce(new Error('Admin access required'));

    await nameField().setValue('Files');
    await save();

    expect(wrapper.text()).toContain('Failed to save: Admin access required');
    expect(nameField().element.value).toBe('Files');
    expect(button('common.save')).toBeDefined();
  });

  it('go back to what is stored when the changes are discarded, logo included', async () => {
    await open();
    fetchMock.mockResolvedValue(answer(200, { logoUrl: UPLOADED }));

    await nameField().setValue('Files');
    await chooseLogo(logoFile('logo.svg', 'image/svg+xml'));
    expect(logoShown()).toBe(UPLOADED);
    await button('common.discard').trigger('click');

    expect(nameField().element.value).toBe('Chez Benjy');
    expect(logoShown()).toBe('/static/logos/custom-logo.png');
    expect(button('common.save')).toBeUndefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});

describe('a new logo', () => {
  it('is uploaded when chosen, and saved as the logo only with the address the server gave', async () => {
    await open();
    let settle;
    fetchMock.mockReturnValue(new Promise((resolve) => (settle = resolve)));

    await chooseLogo(logoFile('logo.svg', 'image/svg+xml'));

    // A second file cannot be chosen while the first is on its way.
    expect(button('settings.branding.uploading').attributes('disabled')).toBeDefined();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings/upload-logo');
    expect(request.method).toBe('POST');
    expect(request.body.get('logo').name).toBe('logo.svg');

    settle(answer(200, { logoUrl: UPLOADED }));
    await flushPromises();

    expect(logoShown()).toBe(UPLOADED);
    expect(wrapper.text()).toContain('settings.branding.uploadSuccess');
    expect(appSettings.save).not.toHaveBeenCalled();

    await save();

    expect(appSettings.save).toHaveBeenCalledWith({
      branding: { appName: 'Chez Benjy', appLogoUrl: UPLOADED, showPoweredBy: true },
    });
  });

  it('is refused before it is uploaded when it is larger than 2 MB', async () => {
    await open();

    await chooseLogo(logoFile('huge.png', 'image/png', TWO_MB + 1));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.branding.logoError');
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(button('common.save')).toBeUndefined();
  });

  it('is accepted at exactly 2 MB', async () => {
    await open();
    fetchMock.mockResolvedValue(answer(200, { logoUrl: UPLOADED }));

    await chooseLogo(logoFile('exact.png', 'image/png', TWO_MB));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is refused before it is uploaded when it is not an SVG, PNG or JPEG image', async () => {
    await open();

    await chooseLogo(logoFile('logo.gif', 'image/gif'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('settings.branding.invalidFileType');
    expect(logoShown()).toBe(STORED.appLogoUrl);
  });

  it('that the server failed to store is reported with its reason, leaving the logo as it was', async () => {
    await open();
    fetchMock.mockResolvedValue(answer(500, { error: 'Failed to save logo' }));

    await chooseLogo(logoFile('logo.png', 'image/png'));

    expect(wrapper.text()).toContain('Upload failed: Failed to save logo');
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(button('common.save')).toBeUndefined();
    // Another attempt is possible straight away.
    expect(button('Upload another file').attributes('disabled')).toBeUndefined();
  });

  it('that the server accepted without giving an address is reported, not shown', async () => {
    await open();
    fetchMock.mockResolvedValue(answer(200, {}));

    await chooseLogo(logoFile('logo.png', 'image/png'));

    expect(wrapper.text()).toContain('Upload failed: No logo URL returned from server');
    expect(logoShown()).toBe(STORED.appLogoUrl);
    expect(button('common.save')).toBeUndefined();
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
  });
});
