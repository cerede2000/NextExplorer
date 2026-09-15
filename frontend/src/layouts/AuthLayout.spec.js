import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The frame around the sign-in and setup screens.
 *
 * While the application works out who is signed in, it shows a spinner and one
 * sentence. That sentence called a `t` the component never declared, so the
 * frame threw instead of rendering and the page stayed blank for exactly as
 * long as it was supposed to say it was preparing.
 */

import AuthLayout from './AuthLayout.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { auth: { preparing: 'Preparing your explorer…' } } },
});

let wrapper;
let errors;

const mountLayout = (props) => {
  setActivePinia(createPinia());
  errors = [];
  wrapper = mount(AuthLayout, {
    props: { version: '3.6.0', ...props },
    global: {
      plugins: [i18n],
      stubs: { HeaderLogo: true, LanguageSelector: true },
      config: { errorHandler: (error) => errors.push(error) },
    },
  });
  return wrapper;
};

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the auth layout while it prepares', () => {
  it('says it is preparing, rather than failing to render', () => {
    mountLayout({ isLoading: true });

    expect(errors).toEqual([]);
    expect(wrapper.text()).toContain('Preparing your explorer…');
  });

  it('shows what it frames once it is ready', () => {
    setActivePinia(createPinia());
    errors = [];
    wrapper = mount(AuthLayout, {
      props: { version: '3.6.0', isLoading: false },
      slots: { default: '<p data-test="form">the form</p>' },
      global: {
        plugins: [i18n],
        stubs: { HeaderLogo: true, LanguageSelector: true },
        config: { errorHandler: (error) => errors.push(error) },
      },
    });

    expect(errors).toEqual([]);
    expect(wrapper.find('[data-test="form"]').exists()).toBe(true);
  });
});
