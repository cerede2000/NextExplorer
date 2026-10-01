import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

let appSettings;
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

import SettingsFfmpeg from './SettingsFfmpeg.vue';

let wrapper;
const open = async (ffmpeg = { ffmpegPath: null, ffprobePath: null }) => {
  appSettings = reactive({
    systemSettings: { ffmpeg },
    save: vi.fn(async (partial) => {
      appSettings.systemSettings.ffmpeg = partial.ffmpeg;
    }),
  });
  wrapper = mount(SettingsFfmpeg);
  await flushPromises();
};

afterEach(() => wrapper?.unmount());

describe('FFmpeg settings', () => {
  it('saves absolute container paths and can clear them', async () => {
    await open();
    await wrapper.get('[data-test="ffmpeg-path"]').setValue('/host-tools/ffmpeg');
    await wrapper.get('[data-test="ffprobe-path"]').setValue('/host-tools/ffprobe');
    await wrapper.get('[data-test="ffmpeg-settings-save"]').trigger('click');
    await flushPromises();

    expect(appSettings.save).toHaveBeenCalledWith({
      ffmpeg: { ffmpegPath: '/host-tools/ffmpeg', ffprobePath: '/host-tools/ffprobe' },
    });
  });

  it('refuses relative host paths', async () => {
    await open();
    await wrapper.get('[data-test="ffmpeg-path"]').setValue('usr/bin/ffmpeg');

    expect(wrapper.get('[data-test="ffmpeg-settings-invalid"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="ffmpeg-settings-save"]').attributes('disabled')).toBeDefined();
  });
});
