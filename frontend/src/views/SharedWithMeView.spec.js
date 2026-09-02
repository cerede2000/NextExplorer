import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

/**
 * The list of links other people gave you.
 *
 * It had no test at all, and it decides three things worth being sure of: an
 * expired link is not openable, a link is found by what it is called *or* by
 * what it points at, and "recent" means the most recent thing that happened to
 * it — which is not always the same field.
 */

const getSharedWithMe = vi.fn();

vi.mock('@/api/shares.api', () => ({
  getSharedWithMe: (...args) => getSharedWithMe(...args),
}));

const push = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIcon', props: ['item'], template: '<i />' },
}));

import SharedWithMeView from './SharedWithMeView.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: {
        active: 'Active',
        expired: 'Expired',
        all: 'All',
        tryAgain: 'Try again',
        noExpiration: 'No expiry',
      },
      actions: { sortBy: 'Sort' },
      errors: { loadShares: 'Could not load' },
      share: {
        sharedWithMe: 'Shared with me',
        sharedItem: 'Shared item',
        filterByNameOrPath: 'Filter',
        noSharedItemsToShow: 'Nothing to show',
      },
    },
  },
});

const hour = 3600_000;
const inThePast = new Date(Date.now() - hour).toISOString();
const inTheFuture = new Date(Date.now() + hour).toISOString();

const share = (overrides) => ({
  shareToken: 'token-' + (overrides.sourceName || overrides.label || 'x'),
  isDirectory: false,
  expiresAt: null,
  createdAt: inThePast,
  ...overrides,
});

const open = async (shares) => {
  getSharedWithMe.mockResolvedValue({ shares });
  const wrapper = mount(SharedWithMeView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
};

const rowLabels = (wrapper) =>
  wrapper
    .findAll('[data-share-label]')
    .map((node) => node.text())
    .filter(Boolean);

beforeEach(() => {
  getSharedWithMe.mockReset();
  push.mockReset();
});

describe('what the list shows', () => {
  it('hides an expired link until asked for it', async () => {
    const wrapper = await open([
      share({ label: 'Still good', expiresAt: inTheFuture }),
      share({ label: 'Ran out', expiresAt: inThePast }),
    ]);

    expect(wrapper.text()).toContain('Still good');
    expect(wrapper.text()).not.toContain('Ran out');
  });

  it('shows only the expired ones when asked for those', async () => {
    const wrapper = await open([
      share({ label: 'Still good', expiresAt: inTheFuture }),
      share({ label: 'Ran out', expiresAt: inThePast }),
    ]);

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Expired')
      .trigger('click');

    expect(wrapper.text()).toContain('Ran out');
    expect(wrapper.text()).not.toContain('Still good');
  });

  it('shows both when asked for all of them', async () => {
    const wrapper = await open([
      share({ label: 'Still good', expiresAt: inTheFuture }),
      share({ label: 'Ran out', expiresAt: inThePast }),
    ]);

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'All')
      .trigger('click');

    expect(wrapper.text()).toContain('Still good');
    expect(wrapper.text()).toContain('Ran out');
  });

  it('calls a link by its label, or by what it points at, or something', async () => {
    const wrapper = await open([
      share({ label: 'Given a name', sourceName: 'ignored.txt' }),
      share({ label: null, sourceName: 'from-the-file.txt' }),
      share({ label: null, sourceName: null }),
    ]);

    expect(wrapper.text()).toContain('Given a name');
    expect(wrapper.text()).toContain('from-the-file.txt');
    expect(wrapper.text()).toContain('Shared item');
  });
});

describe('finding one among many', () => {
  it('matches what it is called', async () => {
    const wrapper = await open([
      share({ label: 'Holiday photos', sourceName: 'a.jpg' }),
      share({ label: 'Tax return', sourceName: 'b.pdf' }),
    ]);

    await wrapper.find('input[type="text"]').setValue('holiday');

    expect(wrapper.text()).toContain('Holiday photos');
    expect(wrapper.text()).not.toContain('Tax return');
  });

  it('matches what it points at, even when it has a different label', async () => {
    const wrapper = await open([
      share({ label: 'Holiday photos', sourceName: 'beach.jpg' }),
      share({ label: 'Tax return', sourceName: 'form.pdf' }),
    ]);

    await wrapper.find('input[type="text"]').setValue('beach');

    expect(wrapper.text()).toContain('Holiday photos');
    expect(wrapper.text()).not.toContain('Tax return');
  });
});

describe('the order they come in', () => {
  /**
   * "Recent" is the most recent thing that happened to a link, and which field
   * holds that depends on what happened: opened, changed, or only ever made.
   * A list ordered by creation alone puts a link somebody opened this morning
   * below one nobody has touched since it was made.
   */
  it('puts the most recently touched first, whichever field says so', async () => {
    const wrapper = await open([
      share({ label: 'Made yesterday', createdAt: new Date(Date.now() - 48 * hour).toISOString() }),
      share({
        label: 'Opened just now',
        createdAt: new Date(Date.now() - 72 * hour).toISOString(),
        lastAccessedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);

    expect(rowLabels(wrapper)[0]).toContain('Opened just now');
  });

  it('sorts by name when asked to', async () => {
    const wrapper = await open([
      share({ label: 'Zebra', lastAccessedAt: new Date().toISOString() }),
      share({ label: 'Antelope', createdAt: inThePast }),
    ]);

    await wrapper.find('[title="Sort"]').trigger('click');

    expect(rowLabels(wrapper)[0]).toContain('Antelope');
  });
});

describe('opening one', () => {
  it('navigates into the share', async () => {
    const wrapper = await open([share({ label: 'Open me', shareToken: 'abc123' })]);

    await wrapper.find('[data-share-row]').trigger('click');

    expect(push).toHaveBeenCalledWith({
      name: 'FolderView',
      params: { path: 'share/abc123' },
    });
  });

  /**
   * An expired link leads nowhere, and following it lands on an error the
   * person cannot act on. It is shown, and it does not open.
   */
  it('refuses to open one that has run out', async () => {
    const wrapper = await open([share({ label: 'Ran out', expiresAt: inThePast })]);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'All')
      .trigger('click');

    await wrapper.find('[data-share-row]').trigger('click');

    expect(push).not.toHaveBeenCalled();
  });
});

describe('while it is loading, and when it will not', () => {
  it('says nothing was found rather than showing an empty page', async () => {
    const wrapper = await open([]);

    expect(wrapper.text()).toContain('Nothing to show');
  });

  it('reports a failure and offers to try again', async () => {
    getSharedWithMe.mockRejectedValue(new Error('Network down'));
    const wrapper = mount(SharedWithMeView, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Network down');
    expect(wrapper.text()).toContain('Try again');
  });
});
