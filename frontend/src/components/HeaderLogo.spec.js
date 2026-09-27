import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

/**
 * The logo at the top of every page.
 *
 * Its alternative text is the only thing a screen reader is given for it, and
 * it was built in the component — the application's name and the English word
 * "logo" — whatever language the rest of the page was being read in. Built is
 * the part that cannot be translated: German puts the word first, Korean puts
 * it last, and neither is a name with a word stuck after it.
 *
 * The string is shared with the settings page, which shows the same logo under
 * the name being edited.
 */

import HeaderLogo from './HeaderLogo.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: {
    en: { common: { logoAlt: '{name} logo' } },
    de: { common: { logoAlt: 'Logo von {name}' } },
    ko: { common: { logoAlt: '{name} 로고' } },
  },
});

let wrapper;

const mountLogo = (props = {}) => {
  wrapper = mount(HeaderLogo, {
    props,
    global: { plugins: [i18n], stubs: { 'router-link': { template: '<a><slot /></a>' } } },
  });
  return wrapper;
};

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  i18n.global.locale.value = 'en';
});

describe('the header logo', () => {
  it.each([
    ['en', 'Ma Bibliothèque logo'],
    ['de', 'Logo von Ma Bibliothèque'],
    ['ko', 'Ma Bibliothèque 로고'],
  ])('describes itself in %s, as that catalogue words it', (locale, expected) => {
    i18n.global.locale.value = locale;

    mountLogo({ appname: 'Ma Bibliothèque' });

    expect(wrapper.get('img').attributes('alt')).toBe(expected);
  });
});
