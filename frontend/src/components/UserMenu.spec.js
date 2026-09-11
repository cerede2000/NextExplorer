import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import UserMenu from './UserMenu.vue';
import { useAuthStore } from '@/stores/auth';

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * The account menu is the only way to Settings and to Sign out. Its toggle was a
 * div carrying type="button", which a div ignores: it answered a mouse click and
 * nothing else. It could not take focus, and a focused element is the only one
 * that receives Enter or Space — so anyone on a keyboard had no way into the
 * menu, and no way to sign out.
 */
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { settings: 'Settings' },
      user: {
        account: 'Account',
        signOut: 'Sign out',
        useSystemTheme: 'Use system theme',
        useLightTheme: 'Use light theme',
        useDarkTheme: 'Use dark theme',
        systemTheme: 'System theme',
        lightTheme: 'Light theme',
        darkTheme: 'Dark theme',
      },
    },
  },
});

/**
 * Press a key the way a browser does: on whatever has focus.
 *
 * jsdom delivers the key events and stops there. A browser goes on to activate
 * a focused button — on Enter as the key goes down, on Space as it comes back
 * up, unless the page cancelled the key — and jsdom does that for nothing at
 * all, a real button included. That one step is taken here, and only for a
 * button, as a browser takes it: a div, even one given a click handler and a
 * tabindex, stays inert on screen and stays inert here. The browser journey in
 * e2e/app/core-flows.spec.js presses the real keys.
 */
const press = (key) => {
  const target = document.activeElement;
  const init = { key, bubbles: true, cancelable: true };
  const down = target.dispatchEvent(new KeyboardEvent('keydown', init));
  const up = target.dispatchEvent(new KeyboardEvent('keyup', init));

  if (!(target instanceof HTMLButtonElement) || target.disabled) return;
  if ((key === 'Enter' && down) || (key === ' ' && down && up)) target.click();
};

describe('UserMenu toggle', () => {
  let wrapper;

  beforeEach(() => {
    setActivePinia(createPinia());
    useAuthStore().currentUser = { username: 'admin', email: 'admin@example.com' };
    wrapper = mount(UserMenu, { global: { plugins: [i18n] }, attachTo: document.body });
  });

  afterEach(() => {
    wrapper.unmount();
  });

  const toggle = () => wrapper.get('[aria-expanded]');
  const menuLabels = () =>
    wrapper
      .findAll('button')
      .filter((button) => !button.attributes('aria-expanded'))
      .map((button) => button.text());

  it('is a button in the tab order, announced as opening a menu', () => {
    const element = toggle().element;

    expect(element.tagName).toBe('BUTTON');
    // Not a submit button: the menu must never post a form it happens to sit in.
    expect(element.getAttribute('type')).toBe('button');
    expect(element.tabIndex).toBe(0);
    expect(element.getAttribute('aria-haspopup')).toBe('menu');
    expect(element.getAttribute('aria-expanded')).toBe('false');

    element.focus();
    expect(document.activeElement).toBe(element);
  });

  it('opens on Enter, and closes on it again', async () => {
    toggle().element.focus();

    press('Enter');
    await nextTick();

    expect(toggle().attributes('aria-expanded')).toBe('true');
    expect(menuLabels()).toEqual(expect.arrayContaining(['Settings', 'Sign out']));

    press('Enter');
    await nextTick();

    expect(toggle().attributes('aria-expanded')).toBe('false');
    expect(menuLabels()).toEqual([]);
  });

  it('opens on Space', async () => {
    toggle().element.focus();

    press(' ');
    await nextTick();

    expect(toggle().attributes('aria-expanded')).toBe('true');
    expect(menuLabels()).toEqual(expect.arrayContaining(['Settings', 'Sign out']));
  });
});
