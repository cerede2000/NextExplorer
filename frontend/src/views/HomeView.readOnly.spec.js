import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The two places a volume is listed — the home page and the sidebar — mark
 * one nothing can be written in, and only that one.
 *
 * A volume bound `:ro` looked like any other until something was attempted in
 * it (nxzai/NextExplorer#407). The reason comes from the server with the
 * volume; the lists only have to carry it through.
 */

const volumeStore = reactive({
  volumes: [],
  usage: {},
  isLoadingVolumes: false,
  hasLoadedVolumes: true,
  isLoadingUsage: false,
  loadVolumes: vi.fn(async () => {}),
});
vi.mock('@/stores/volumeUsage', () => ({ useVolumeUsageStore: () => volumeStore }));
vi.mock('@/stores/features', () => ({
  useFeaturesStore: () => ({
    ensureLoaded: async () => {},
    volumeUsageEnabled: false,
    personalEnabled: false,
  }),
}));
vi.mock('@/stores/favorites', () => ({
  useFavoritesStore: () => ({ ensureLoaded: async () => {}, favorites: [] }),
}));
vi.mock('@/composables/navigation', () => ({
  useNavigation: () => ({ openItem: vi.fn(), openBreadcrumb: vi.fn() }),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }) }));

import HomeView from './HomeView.vue';
import VolMenu from '@/components/VolMenu.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    en: {
      volumes: {
        readOnly: {
          label: 'Read-only',
          storage: 'mounted read-only',
          permission: 'no permission to write',
          access: 'read-only for your account',
        },
      },
    },
  },
});

const marks = (wrapper) =>
  Object.fromEntries(
    wrapper.findAll('button').map((button) => {
      const mark = button.find('[data-testid="volume-read-only"]');
      return [
        button
          .text()
          .replace(/Read-only.*$/, '')
          .trim(),
        mark.exists() ? mark.attributes('data-reason') : null,
      ];
    })
  );

beforeEach(() => {
  setActivePinia(createPinia());
  volumeStore.volumes = [
    { name: 'torrents', path: 'torrents', kind: 'volume', readOnly: 'storage' },
    { name: 'shared', path: 'shared', kind: 'volume', readOnly: null },
    { name: 'locked', path: 'locked', kind: 'volume', readOnly: 'permission' },
    { name: 'book', path: 'book', kind: 'volume' },
  ];
});

describe.each([
  ['the home page', HomeView],
  ['the sidebar', VolMenu],
])('%s', (_where, component) => {
  it('marks the volumes nothing can be written in, and no others', async () => {
    const wrapper = mount(component, { global: { plugins: [i18n] } });
    await flushPromises();

    const found = marks(wrapper);
    expect(found.torrents).toBe('storage');
    expect(found.locked).toBe('permission');
    expect(found.shared).toBeNull();
    // A server that predates the question says nothing, and neither does the list.
    expect(found.book).toBeNull();
    wrapper.unmount();
  });
});
