import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configError = ref(null);
const dismissConfigWarning = vi.fn(() => {
  if (configError.value?.mode === 'mismatch') {
    configError.value = null;
  }
});

vi.mock('@/composables/useConfigErrorGate', () => ({
  useConfigErrorGate: () => ({
    configError,
    dismissConfigWarning,
  }),
}));

vi.mock('@/components/ConfigWarningNotice.vue', () => ({
  default: {
    props: ['expectedOrigin', 'requestOrigin'],
    emits: ['dismiss'],
    template:
      '<div data-test="config-warning">PUBLIC_URL warning<button aria-label="Dismiss warning" @click="$emit(\'dismiss\')">Dismiss</button></div>',
  },
}));

// The account's language is the settings store's business, and this spec is
// about the configuration gate: what belongs here is that the shell asks for
// it at all, which the test at the bottom checks.
const accountLanguage = vi.fn();
vi.mock('@/composables/useAccountLanguage', () => ({
  useAccountLanguage: () => accountLanguage(),
}));

// The tabs follow the address from the shell, for the same reason the language is
// applied there: it has to hold across every screen and outlive the route changes
// between them. Mocked here because this spec is about the configuration gate;
// that the shell asks for it at all is checked below.
const tabRouteSync = vi.fn();
vi.mock('@/composables/tabNavigation', () => ({
  useTabRouteSync: () => tabRouteSync(),
}));

vi.mock('@/components/TabStrip.vue', () => ({
  default: { template: '<div data-test="tab-strip-stub"></div>' },
}));

// Every tab's open document, mounted here and only here: it has to outlive the
// pages, or bringing a folder tab forward and going back would rebuild whatever
// was open. Stubbed because this spec is about the configuration gate; that the
// shell mounts it, once, is checked below.
const previewHost = vi.fn();
vi.mock('@/plugins/preview/PreviewHost.vue', () => ({
  default: {
    setup: () => previewHost(),
    template: '<div data-test="preview-host-stub"></div>',
  },
}));

vi.mock('@/components/ConfigErrorScreen.vue', () => ({
  default: {
    props: ['mode', 'expectedOrigin', 'requestOrigin'],
    template: '<div data-test="config-error">This app isn’t configured correctly.</div>',
  },
}));

import App from '@/App.vue';

describe('App config error handling', () => {
  beforeEach(() => {
    configError.value = null;
    dismissConfigWarning.mockClear();
    accountLanguage.mockClear();
    tabRouteSync.mockClear();
    previewHost.mockClear();
  });

  /**
   * Asked for by the shell and nowhere else, so it holds for every screen —
   * a folder, a document, the editor — and outlives the route changes between
   * them (nxzai/NextExplorer discussion #408).
   */
  it('puts the account’s language on screen', () => {
    mount(App, { global: { stubs: { RouterView: true } } });

    expect(accountLanguage).toHaveBeenCalledTimes(1);
  });

  /**
   * Once, and from the shell: the strip is only drawn where a tab can be, and the
   * tabs have to keep up with the address wherever it goes. Asked for in a screen
   * instead, every folder row that wanted the middle-button gesture would have
   * installed another copy of the same watcher.
   */
  it('has the tabs follow the address, once', () => {
    mount(App, { global: { stubs: { RouterView: true } } });

    expect(tabRouteSync).toHaveBeenCalledTimes(1);
  });

  /**
   * Here rather than in the pages that show documents, and that is the point:
   * a surface mounted by a page is built when that page is and thrown away when
   * it is, so bringing a folder tab forward and coming back re-opened an
   * ONLYOFFICE document from nothing — new connection, no cursor, no undo.
   */
  it('keeps every tab’s document in one place, mounted once', () => {
    const wrapper = mount(App, { global: { stubs: { RouterView: true } } });

    expect(previewHost).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('[data-test="preview-host-stub"]')).toHaveLength(1);
  });

  it('shows a dismissible warning for PUBLIC_URL mismatches without blocking the router', async () => {
    configError.value = {
      mode: 'mismatch',
      expectedOrigin: 'https://files.example.com',
      requestOrigin: 'https://alt.example.com',
    };

    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: {
            template: '<div data-test="router-view">router content</div>',
          },
        },
      },
    });

    await flushPromises();

    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('PUBLIC_URL warning');

    await wrapper.get('button[aria-label="Dismiss warning"]').trigger('click');
    await flushPromises();
    await flushPromises();

    expect(dismissConfigWarning).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('PUBLIC_URL warning');
  });

  it('blocks the router when server settings cannot be loaded', async () => {
    configError.value = {
      mode: 'error',
      expectedOrigin: '',
      requestOrigin: 'https://alt.example.com',
    };

    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: {
            template: '<div data-test="router-view">router content</div>',
          },
        },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain('This app isn’t configured correctly.');
    expect(wrapper.find('[data-test="router-view"]').exists()).toBe(false);
  });
});
