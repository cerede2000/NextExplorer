import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The list of links you gave to other people.
 *
 * It shares its filtering, searching and ordering with the list of links other
 * people gave you, and both had no test. Covered here before that shared part
 * is moved out of the two files it lives in twice, so the move can be checked
 * rather than trusted.
 *
 * What differs between the two, and matters: this one is searched by the path
 * a link points at, the other by the file's name.
 */

const getMyShares = vi.fn();

vi.mock('@/api/shares.api', () => ({
  getMyShares: (...args) => getMyShares(...args),
  deleteShare: vi.fn(),
  copyShareUrl: vi.fn(),
  copyDirectShareFileUrl: vi.fn(),
  DIRECT_SHARE_FILE_MODES: [
    { value: 'auto', labelKey: 'share.directLinkModes.auto', fallback: 'Auto' },
    { value: 'raw', labelKey: 'share.directLinkModes.raw', fallback: 'Raw' },
  ],
}));

vi.mock('@/api/users.api', () => ({ fetchShareableUsers: vi.fn(async () => ({ users: [] })) }));

vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIcon', props: ['item'], template: '<i />' },
}));
vi.mock('@/components/ModalDialog.vue', () => ({
  default: { name: 'ModalDialog', template: '<div><slot /></div>' },
}));
vi.mock('@/components/ShareDialog.vue', () => ({
  default: { name: 'ShareDialog', template: '<div />' },
}));

import SharedByMeView from './SharedByMeView.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  missingWarn: false,
  fallbackWarn: false,
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
        sharedByMe: 'Shared by me',
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
  id: overrides.label || overrides.sourcePath || 'id',
  shareToken: 'token',
  isDirectory: false,
  expiresAt: null,
  createdAt: inThePast,
  sharingType: 'anyone',
  accessMode: 'readonly',
  ...overrides,
});

const open = async (shares) => {
  getMyShares.mockResolvedValue({ shares });
  const wrapper = mount(SharedByMeView, { global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
};

const labels = (wrapper) => wrapper.findAll('[data-share-label]').map((node) => node.text());
const clickFilter = (wrapper, text) =>
  wrapper
    .findAll('button')
    .find((button) => button.text() === text)
    .trigger('click');

beforeEach(() => {
  // The row's direct-link menu asks whether a file is editable, which reads a
  // store: without an active Pinia the whole row fails to render.
  setActivePinia(createPinia());
  getMyShares.mockReset();
});

describe('the links you handed out', () => {
  it('hides an expired one until asked for it', async () => {
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

    await clickFilter(wrapper, 'Expired');

    expect(wrapper.text()).toContain('Ran out');
    expect(wrapper.text()).not.toContain('Still good');
  });

  /**
   * This list is searched by where a link points, not by the file's name —
   * somebody looking for what they shared out of `Projects/2026` types that.
   */
  it('is searched by the path a link points at', async () => {
    const wrapper = await open([
      share({ label: 'Quarterly', sourcePath: 'Projects/2026/report.pdf' }),
      share({ label: 'Holiday', sourcePath: 'Photos/beach.jpg' }),
    ]);

    await wrapper.find('input[type="text"]').setValue('projects/2026');

    expect(wrapper.text()).toContain('Quarterly');
    expect(wrapper.text()).not.toContain('Holiday');
  });

  it('is searched by label too', async () => {
    const wrapper = await open([
      share({ label: 'Quarterly', sourcePath: 'a/b.pdf' }),
      share({ label: 'Holiday', sourcePath: 'c/d.jpg' }),
    ]);

    await wrapper.find('input[type="text"]').setValue('holiday');

    expect(wrapper.text()).toContain('Holiday');
    expect(wrapper.text()).not.toContain('Quarterly');
  });

  it('puts the most recently touched first, whichever field says so', async () => {
    const wrapper = await open([
      share({ label: 'Made yesterday', createdAt: new Date(Date.now() - 48 * hour).toISOString() }),
      share({
        label: 'Opened just now',
        createdAt: new Date(Date.now() - 72 * hour).toISOString(),
        lastAccessedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);

    expect(labels(wrapper)[0]).toContain('Opened just now');
  });

  it('sorts by name when asked to', async () => {
    const wrapper = await open([
      share({ label: 'Zebra', lastAccessedAt: new Date().toISOString() }),
      share({ label: 'Antelope', createdAt: inThePast }),
    ]);

    await wrapper.find('[title="Sort"]').trigger('click');

    expect(labels(wrapper)[0]).toContain('Antelope');
  });
});

describe('when there is nothing, or nothing works', () => {
  it('says nothing was found rather than showing an empty page', async () => {
    const wrapper = await open([]);

    expect(wrapper.text()).toContain('Nothing to show');
  });

  it('reports a failure and offers to try again', async () => {
    getMyShares.mockRejectedValue(new Error('Network down'));
    const wrapper = mount(SharedByMeView, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Network down');
    expect(wrapper.text()).toContain('Try again');
  });
});
