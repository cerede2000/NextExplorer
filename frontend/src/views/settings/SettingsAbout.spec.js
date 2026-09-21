import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

const fetchCapabilities = vi.fn();
vi.mock('@/api', () => ({
  fetchCapabilities: (...args) => fetchCapabilities(...args),
  fetchFeatures: vi.fn().mockResolvedValue({}),
}));

import SettingsAbout from './SettingsAbout.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * The optional tools, on the page an administrator already opens to learn the
 * version — the same report the server writes to its log at start, for the
 * people who do not read it (#9).
 */
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    en: {
      titles: { about: 'About' },
      common: { unknown: 'Unknown' },
      settings: {
        about: {
          subtitle: '',
          appVersion: '',
          appVersionHelp: '',
          gitCommit: '',
          gitCommitHelp: '',
          branch: '',
          branchHelp: '',
          tools: {
            title: 'Optional tools',
            subtitle: '',
            installed: 'Installed',
            missing: 'Not installed',
            unused: 'Not used here',
            package: 'Package',
            cannotOpen: 'Cannot open: {formats}',
            gives: {
              videoThumbnails: 'Video thumbnails',
              fastSearch: 'Fast search inside files',
              copyProgress: 'Progress on large copies',
              archives: 'Archives beyond .zip',
            },
          },
        },
      },
    },
  },
});

const mountPage = async () => {
  const wrapper = mount(SettingsAbout, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  fetchCapabilities.mockReset();
});

describe('the optional tools on the About page', () => {
  it('lists each one for an administrator, with what it gives and whether it is there', async () => {
    useAuthStore().currentUser = { id: 'a', roles: ['admin'] };
    fetchCapabilities.mockResolvedValue({
      capabilities: [
        { name: 'ffmpeg', available: true, enables: 'videoThumbnails', install: 'ffmpeg' },
        { name: 'ripgrep', available: false, enables: 'fastSearch', install: 'ripgrep' },
      ],
    });

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="about-tool-status-ffmpeg"]').text()).toBe('Installed');
    expect(wrapper.find('[data-testid="about-tool-status-ripgrep"]').text()).toBe('Not installed');
    // What it would take is said beside what is missing, and only there.
    expect(wrapper.find('[data-testid="about-tool-ripgrep"]').text()).toContain('ripgrep');
    expect(wrapper.find('[data-testid="about-tool-ripgrep"]').text()).toContain('Package');
    expect(wrapper.find('[data-testid="about-tool-ffmpeg"]').text()).not.toContain('Package');
  });

  it('shows the version each tool says it is, and none it did not say', async () => {
    useAuthStore().currentUser = { id: 'a', roles: ['admin'] };
    fetchCapabilities.mockResolvedValue({
      capabilities: [
        {
          name: 'ffmpeg',
          available: true,
          version: '8.1.3',
          enables: 'videoThumbnails',
          install: 'ffmpeg',
        },
        // There, and its answer did not say a version: shown without one
        // rather than as a guess.
        {
          name: 'rsync',
          available: true,
          version: null,
          enables: 'copyProgress',
          install: 'rsync',
        },
        {
          name: 'ripgrep',
          available: false,
          version: null,
          enables: 'fastSearch',
          install: 'ripgrep',
        },
      ],
    });

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="about-tool-version-ffmpeg"]').text()).toBe('8.1.3');
    expect(wrapper.find('[data-testid="about-tool-ffmpeg"]').text()).toContain('ffmpeg 8.1.3');
    expect(wrapper.find('[data-testid="about-tool-version-rsync"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="about-tool-version-ripgrep"]').exists()).toBe(false);
  });

  it('says which archive formats are missing, and the package that brings them', async () => {
    useAuthStore().currentUser = { id: 'a', roles: ['admin'] };
    fetchCapabilities.mockResolvedValue({
      capabilities: [
        {
          name: '7-Zip',
          available: true,
          enables: 'archives',
          install: '7zip',
          missingFormats: ['rar'],
          installMissing: '7zip-rar',
        },
      ],
    });

    const wrapper = await mountPage();

    const missing = wrapper.find('[data-testid="about-tool-missing-formats"]');
    expect(missing.text()).toContain('Cannot open: rar');
    expect(missing.text()).toContain('7zip-rar');
  });

  it('tells a tool the instance does not use apart from one it lacks', async () => {
    useAuthStore().currentUser = { id: 'a', roles: ['admin'] };
    fetchCapabilities.mockResolvedValue({
      capabilities: [
        {
          name: 'rsync',
          available: false,
          used: false,
          enables: 'copyProgress',
          install: 'rsync',
        },
      ],
    });

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="about-tool-status-rsync"]').text()).toBe('Not used here');
    expect(wrapper.find('[data-testid="about-tool-rsync"]').text()).not.toContain('Package');
  });

  it('does not ask, and shows nothing, for anybody else', async () => {
    useAuthStore().currentUser = { id: 'u', roles: ['user'] };

    const wrapper = await mountPage();

    expect(fetchCapabilities).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="about-tools"]').exists()).toBe(false);
  });

  it('keeps the page when the report cannot be had', async () => {
    useAuthStore().currentUser = { id: 'a', roles: ['admin'] };
    fetchCapabilities.mockRejectedValue(new Error('offline'));

    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="about-tools"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('About');
  });
});
