import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

import ReadOnlyMark from './ReadOnlyMark.vue';

/**
 * The mark beside a volume nothing can be written in.
 *
 * A volume mounted read-only looked like any other until something was tried
 * in it (nxzai/NextExplorer#407). The server says why; the mark says it on
 * hover and to a screen reader, and says nothing at all when there is nothing
 * to say.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
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

const mark = (reason) => mount(ReadOnlyMark, { props: { reason }, global: { plugins: [i18n] } });

describe('the read-only mark', () => {
  it.each([
    ['storage', 'mounted read-only'],
    ['permission', 'no permission to write'],
    ['access', 'read-only for your account'],
  ])('says why for %s', (reason, said) => {
    const wrapper = mark(reason);
    const shown = wrapper.get('[data-testid="volume-read-only"]');

    expect(shown.attributes('title')).toBe(said);
    expect(shown.attributes('data-reason')).toBe(reason);
    // Not only on hover: a screen reader hears it, and a touch screen has no hover.
    expect(shown.get('.sr-only').text()).toBe(`Read-only — ${said}`);
  });

  it.each([null, undefined, '', 'something-new'])('is absent for %s', (reason) => {
    expect(mark(reason).find('[data-testid="volume-read-only"]').exists()).toBe(false);
  });
});
