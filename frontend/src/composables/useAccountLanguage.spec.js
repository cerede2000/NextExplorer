import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

/**
 * The language of whoever is signed in.
 *
 * It belongs to the account and not to the browser: somebody signing in from a
 * machine that is not theirs gets their own language, and the picker on the
 * sign-in page — the only other way to choose one — is never seen again once
 * they are in, which is why it could not be found at all
 * (nxzai/NextExplorer discussion #408).
 *
 * The real translations are used here rather than a stub: what is worth
 * checking is that a language this build carries is applied and one it does not
 * falls back, and a stub would decide both by itself.
 */

let appSettings;
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));

import { useAccountLanguage } from './useAccountLanguage';
import i18n from '@/i18n';

const Shell = defineComponent({
  setup() {
    useAccountLanguage();
    return () => null;
  },
});

let wrapper = null;

/** The application put on screen for an account whose settings say this. */
const show = (userSettings = {}) => {
  appSettings = reactive({ userSettings });
  wrapper = mount(Shell);
  return appSettings;
};

const shown = () => i18n.global.locale.value;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  i18n.global.locale.value = 'en';
  document.documentElement.removeAttribute('lang');
});

describe('the language on screen', () => {
  it('is the one the account asked for', async () => {
    show({ locale: 'nl' });
    await nextTick();

    expect(shown()).toBe('nl');
    // Said out loud as well, for a screen reader and for the browser's own
    // spell checking, which read the page's language and not ours.
    expect(document.documentElement.getAttribute('lang')).toBe('nl');
  });

  it('follows the browser while the account asks for nothing', async () => {
    show({});
    await nextTick();

    expect(shown()).toBe('en');
  });

  it('falls back for a language this build does not carry', async () => {
    show({ locale: 'xx-YY' });
    await nextTick();

    expect(shown()).toBe('en');
  });

  it('follows the account as the answer arrives, and as it changes', async () => {
    const settings = show({});
    await nextTick();

    // The settings fetched after signing in.
    settings.userSettings = { locale: 'fr' };
    await nextTick();
    expect(shown()).toBe('fr');

    // A save on the preferences page.
    settings.userSettings = { ...settings.userSettings, locale: 'de' };
    await nextTick();
    expect(shown()).toBe('de');

    // The store emptying itself when the account changes: back to the
    // browser's, rather than the last account's language left on screen.
    settings.userSettings = { locale: null };
    await nextTick();
    expect(shown()).toBe('en');
  });
});
