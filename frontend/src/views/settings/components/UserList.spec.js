import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import UserList from './UserList.vue';

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    locale: { value: 'en' },
  }),
}));

/**
 * The list of accounts, and the one question it could not answer: why can this
 * person not sign in? A lock freed itself after a while and showed nowhere, so
 * an administrator looking at the list saw an ordinary account.
 */

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });

const account = (overrides = {}) => ({
  id: 'u1',
  username: 'alice',
  email: 'alice@example.com',
  roles: [],
  authMethods: [],
  lockedUntil: null,
  ...overrides,
});

let wrapper;

afterEach(() => {
  wrapper?.unmount();
});

const badgeOf = (users) => {
  wrapper = mount(UserList, { props: { users } });
  return wrapper.find('[data-test="locked-badge"]');
};

describe('an account in the list', () => {
  it('is marked when locked, and says until when', () => {
    const until = inMinutes(12);

    const badge = badgeOf([account({ lockedUntil: until })]);

    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('settings.users.lockedBadge');
    expect(badge.attributes('title')).toBe(
      `settings.users.lockedUntil:${JSON.stringify({ time: timeOf(until) })}`
    );
  });

  it('is not marked when it holds no lock', () => {
    expect(badgeOf([account()]).exists()).toBe(false);
  });

  /** The list is read once; a lock can run out while it sits open. */
  it('is not marked when its lock has already run out', () => {
    expect(badgeOf([account({ lockedUntil: inMinutes(-1) })]).exists()).toBe(false);
  });
});
