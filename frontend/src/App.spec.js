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
