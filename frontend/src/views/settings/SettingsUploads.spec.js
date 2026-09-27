import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * How files travel to the server: whole, in chunks of a chosen size, or whole
 * with a fallback to chunks once a proxy has refused a large body.
 *
 * The size is edited in MiB and stored in bytes, and the server will not take a
 * chunk above its own ceiling. A unit lost on the way, or a size above that
 * ceiling, breaks every upload for everybody until somebody comes back to this
 * page. The two modes also exclude each other: stored both on, the uploader is
 * left with contradictory instructions.
 */

const MIB = 1024 * 1024;

const getUploadFallbackMiB = vi.fn();
const resetUploadFallback = vi.fn();
let appSettings;
let features;

vi.mock('@/composables/fileUploader', () => ({
  getUploadFallbackMiB: (...args) => getUploadFallbackMiB(...args),
  resetUploadFallback: (...args) => resetUploadFallback(...args),
}));
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsUploads from './SettingsUploads.vue';

const STORED = { chunkedEnabled: true, chunkedAutoFallback: false, chunkSizeBytes: 16 * MIB };

let wrapper;

const open = async ({ uploads = STORED, ceilingBytes = 64 * MIB, fallbackMiB = null } = {}) => {
  features = reactive({ maxUploadChunkSizeBytes: ceilingBytes, ensureLoaded: vi.fn() });
  appSettings = reactive({
    systemSettings: { uploads },
    state: {},
    save: vi.fn(async (partial) => {
      appSettings.systemSettings.uploads = {
        ...appSettings.systemSettings.uploads,
        ...partial.uploads,
      };
    }),
  });
  getUploadFallbackMiB.mockReturnValue(fallbackMiB);
  wrapper = mount(SettingsUploads);
  await flushPromises();
  return wrapper;
};

const isOn = (toggle) => toggle.attributes('aria-checked') === 'true';
const chunked = () => wrapper.findAll('[role="switch"]')[0];
const fallback = () => wrapper.findAll('[role="switch"]')[1];
const sizeField = () => wrapper.get('input[type="number"]');
const button = (label) => wrapper.findAll('button').find((item) => item.text() === label);
const sentSize = () => appSettings.save.mock.calls[0][0].uploads.chunkSizeBytes;

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

beforeEach(() => {
  getUploadFallbackMiB.mockReset();
  resetUploadFallback.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
});

describe('the upload settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open();

    expect(isOn(chunked())).toBe(true);
    expect(isOn(fallback())).toBe(false);
    expect(sizeField().element.value).toBe('16');
    expect(button('common.save')).toBeUndefined();
    // The ceiling is part of the server's features, which the page asks for.
    expect(features.ensureLoaded).toHaveBeenCalled();
  });

  it('show the default size of 8 MiB when none is stored, without calling it a change', async () => {
    await open({ uploads: { chunkedEnabled: false } });

    expect(sizeField().element.value).toBe('8');
    expect(button('common.save')).toBeUndefined();
  });

  it('save the size in bytes along with both switches, and then have nothing left to save', async () => {
    await open({
      uploads: { chunkedEnabled: false, chunkedAutoFallback: false, chunkSizeBytes: 8 * MIB },
    });

    await chunked().trigger('click');
    await sizeField().setValue('32');
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(appSettings.save).toHaveBeenCalledWith({
      uploads: { chunkedEnabled: true, chunkedAutoFallback: false, chunkSizeBytes: 32 * MIB },
    });
    expect(button('common.save')).toBeUndefined();
  });

  it('bring a size typed above the server ceiling down to the ceiling before it is sent', async () => {
    await open({ ceilingBytes: 32 * MIB });

    await sizeField().setValue('100');
    expect(sizeField().element.value).toBe('32');
    await save();

    expect(sentSize()).toBe(32 * MIB);
  });

  it('bring a size below 1 MiB up to 1 MiB, and a fraction to a whole MiB', async () => {
    await open();

    await sizeField().setValue('0');
    expect(sizeField().element.value).toBe('1');

    await sizeField().setValue('2.6');
    expect(sizeField().element.value).toBe('3');
    await save();

    expect(sentSize()).toBe(3 * MIB);
  });

  /**
   * An emptied field holds no number, so there was nothing to bring within
   * bounds, and the page sent it as a size of 0.
   */
  it('show an emptied size as invalid, naming the bounds, and do not send it', async () => {
    await open();

    await sizeField().setValue('');

    expect(wrapper.get('[data-test="uploads-settings-invalid"]').text()).toBe(
      'settings.uploads.chunkSizeInvalid {"max":64}'
    );
    const saveButton = wrapper.get('[data-test="uploads-settings-save"]');
    expect(saveButton.attributes('disabled')).toBeDefined();
    await saveButton.trigger('click');
    await flushPromises();
    expect(appSettings.save).not.toHaveBeenCalled();

    await sizeField().setValue('24');
    expect(wrapper.find('[data-test="uploads-settings-invalid"]').exists()).toBe(false);
    expect(
      wrapper.get('[data-test="uploads-settings-save"]').attributes('disabled')
    ).toBeUndefined();
  });

  it('hold sizes to 512 MiB when the server has not given a ceiling', async () => {
    await open({ ceilingBytes: 0 });

    await sizeField().setValue('900');
    await save();

    expect(sentSize()).toBe(512 * MIB);
  });

  it('show a stored size above the ceiling as the ceiling, and follow the ceiling when it drops', async () => {
    await open({ uploads: { ...STORED, chunkSizeBytes: 48 * MIB }, ceilingBytes: 16 * MIB });

    expect(sizeField().element.value).toBe('16');
    expect(button('common.save')).toBeUndefined();

    features.maxUploadChunkSizeBytes = 8 * MIB;
    await flushPromises();

    expect(sizeField().element.value).toBe('8');
  });

  it('keep forced chunking and the automatic fallback from being on together', async () => {
    await open();

    await fallback().trigger('click');
    expect(isOn(fallback())).toBe(true);
    expect(isOn(chunked())).toBe(false);

    await chunked().trigger('click');
    expect(isOn(chunked())).toBe(true);
    expect(isOn(fallback())).toBe(false);

    await fallback().trigger('click');
    await save();

    expect(appSettings.save).toHaveBeenCalledWith({
      uploads: { chunkedEnabled: false, chunkedAutoFallback: true, chunkSizeBytes: 16 * MIB },
    });
  });

  it('go back to what is stored when the changes are discarded, without sending anything', async () => {
    await open();

    await sizeField().setValue('40');
    await fallback().trigger('click');
    await button('common.discard').trigger('click');

    expect(sizeField().element.value).toBe('16');
    expect(isOn(chunked())).toBe(true);
    expect(isOn(fallback())).toBe(false);
    expect(button('common.save')).toBeUndefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});

describe('the size this browser fell back to', () => {
  it('is shown, and forgotten on request without touching the stored settings', async () => {
    await open({ fallbackMiB: 4 });

    expect(wrapper.text()).toContain('settings.uploads.autoFallbackActive {"size":4}');

    await button('settings.uploads.autoFallbackReset').trigger('click');

    expect(resetUploadFallback).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).not.toContain('settings.uploads.autoFallbackActive');
    expect(appSettings.save).not.toHaveBeenCalled();
  });

  it('is not mentioned when this browser never fell back', async () => {
    await open();

    expect(button('settings.uploads.autoFallbackReset')).toBeUndefined();
  });
});
