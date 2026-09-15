import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * Whether the server makes thumbnails for everybody, and how: their size, their
 * quality and how many are made at once.
 *
 * Switching them off here switches them off for every person, whatever their
 * own preference says, and the numbers decide both how long a folder of photos
 * takes to appear and how hard the server works for it. What is sent has to be
 * the section as edited, numbers as numbers: the server drops a size that
 * arrives as text, and the old value quietly stays.
 */

let appSettings;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import SettingsFilesThumbnails from './SettingsFilesThumbnails.vue';

const STORED = { enabled: true, quality: 85, size: 320, concurrency: 4 };

let wrapper;

const open = async (thumbnails = STORED) => {
  appSettings = reactive({
    systemSettings: { thumbnails },
    state: {},
    save: vi.fn(async (partial) => {
      appSettings.systemSettings.thumbnails = {
        ...appSettings.systemSettings.thumbnails,
        ...partial.thumbnails,
      };
    }),
  });
  wrapper = mount(SettingsFilesThumbnails);
  await flushPromises();
  return wrapper;
};

const enabledSwitch = () => wrapper.get('[role="switch"]');
const qualityField = () => wrapper.findAll('input[type="number"]')[0];
const sizeField = () => wrapper.findAll('input[type="number"]')[1];
const concurrencyField = () => wrapper.findAll('input[type="number"]')[2];
const concurrencySlider = () => wrapper.findAll('input[type="range"]')[1];
const button = (label) => wrapper.findAll('button').find((item) => item.text() === label);

const save = async () => {
  await button('common.save').trigger('click');
  await flushPromises();
};

afterEach(() => {
  wrapper?.unmount();
});

/**
 * The settings page renders before settings have loaded, from the store's
 * defaults, and a server older than the concurrency field stores none. Read as
 * a change, that offered to save straight away — and saving then wrote those
 * defaults over what the administrator had stored.
 */
describe('a stored section without a concurrency', () => {
  it('is not a change to save', async () => {
    await open({ enabled: true, quality: 70, size: 200 });

    expect(concurrencyField().element.value).toBe('10');
    expect(button('common.save')).toBeUndefined();
  });

  it('becomes one once the concurrency is actually changed', async () => {
    await open({ enabled: true, quality: 70, size: 200 });

    await concurrencyField().setValue('6');
    await save();

    expect(appSettings.save).toHaveBeenCalledWith({
      thumbnails: expect.objectContaining({ concurrency: 6 }),
    });
  });
});

describe('the thumbnail settings', () => {
  it('start from what is stored, with nothing to save', async () => {
    await open();

    expect(enabledSwitch().attributes('aria-checked')).toBe('true');
    expect(qualityField().element.value).toBe('85');
    expect(sizeField().element.value).toBe('320');
    expect(concurrencyField().element.value).toBe('4');
    expect(button('common.save')).toBeUndefined();
  });

  it('save the section as edited, numbers as numbers, and then have nothing left to save', async () => {
    await open();

    await qualityField().setValue('90');
    await sizeField().setValue('512');
    await concurrencySlider().setValue('20');
    await save();

    expect(appSettings.save).toHaveBeenCalledTimes(1);
    expect(appSettings.save).toHaveBeenCalledWith({
      thumbnails: { enabled: true, quality: 90, size: 512, concurrency: 20 },
    });
    expect(button('common.save')).toBeUndefined();
  });

  it('switch thumbnails off for everybody, sending the other values unchanged', async () => {
    await open();

    await enabledSwitch().trigger('click');
    await save();

    expect(appSettings.save).toHaveBeenCalledWith({
      thumbnails: { enabled: false, quality: 85, size: 320, concurrency: 4 },
    });
  });

  it('go back to what is stored when the changes are discarded, without sending anything', async () => {
    await open();

    await enabledSwitch().trigger('click');
    await qualityField().setValue('10');
    await sizeField().setValue('1000');
    await concurrencyField().setValue('30');
    await button('common.discard').trigger('click');

    expect(enabledSwitch().attributes('aria-checked')).toBe('true');
    expect(qualityField().element.value).toBe('85');
    expect(sizeField().element.value).toBe('320');
    expect(concurrencyField().element.value).toBe('4');
    expect(button('common.save')).toBeUndefined();
    expect(appSettings.save).not.toHaveBeenCalled();
  });
});
