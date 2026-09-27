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
 *
 * It is also where a link is taken back. Every row carries the same buttons,
 * so the one thing that must hold is that a button acts on its own row: a
 * removal confirmed for one link that revokes another cuts off people who were
 * meant to keep access, and nothing on screen says so until they complain.
 */

const getMyShares = vi.fn();
const deleteShare = vi.fn();
const copyShareUrl = vi.fn();
const copyDirectShareFileUrl = vi.fn();
const fetchShareableUsers = vi.fn();

vi.mock('@/api/shares.api', () => ({
  getMyShares: (...args) => getMyShares(...args),
  deleteShare: (...args) => deleteShare(...args),
  copyShareUrl: (...args) => copyShareUrl(...args),
  copyDirectShareFileUrl: (...args) => copyDirectShareFileUrl(...args),
  DIRECT_SHARE_FILE_MODES: [
    { value: 'auto', labelKey: 'share.directLinkModes.auto', fallback: 'Auto' },
    { value: 'raw', labelKey: 'share.directLinkModes.raw', fallback: 'Raw' },
    { value: 'editor', labelKey: 'share.directLinkModes.editor', fallback: 'Editor' },
  ],
}));

vi.mock('@/api/users.api', () => ({
  fetchShareableUsers: (...args) => fetchShareableUsers(...args),
}));

vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIcon', props: ['item'], template: '<i />' },
}));
// Shown only while it is open, as the real dialog is.
vi.mock('@/components/ModalDialog.vue', () => ({
  default: {
    name: 'ModalDialog',
    props: ['modelValue'],
    template: '<div v-if="modelValue" data-modal><slot name="title" /><slot /></div>',
  },
}));
vi.mock('@/components/ShareDialog.vue', () => ({
  default: {
    name: 'ShareDialog',
    props: ['modelValue', 'share'],
    emits: ['update:modelValue', 'share-updated'],
    template: '<div />',
  },
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
        cancel: 'Cancel',
        delete: 'Delete',
        deleting: 'Deleting',
        close: 'Close',
      },
      actions: { sortBy: 'Sort' },
      errors: { loadShares: 'Could not load', deleteShare: 'Could not remove' },
      share: {
        sharedByMe: 'Shared by me',
        sharedItem: 'Shared item',
        filterByNameOrPath: 'Filter',
        noSharedItemsToShow: 'Nothing to show',
        removeShare: 'Remove',
        activityDetails: 'Activity',
        noActivity: 'Never happened',
        noIpRecorded: 'No address recorded',
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

const QUARTERLY = share({
  id: 'share-quarterly',
  shareToken: 'tok-quarterly',
  label: 'Quarterly',
  sourcePath: 'Projects/2026/report.pdf',
  createdAt: new Date(Date.now() - 2 * hour).toISOString(),
});
const HOLIDAY = share({
  id: 'share-holiday',
  shareToken: 'tok-holiday',
  label: 'Holiday',
  sourcePath: 'Photos/beach.jpg',
  createdAt: inThePast,
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

const row = (wrapper, label) =>
  wrapper
    .findAll('[data-share-row]')
    .find((node) => node.find('[data-share-label]').text() === label);

const modal = (wrapper) => wrapper.find('[data-modal]');
const modalButton = (wrapper, text) =>
  modal(wrapper)
    .findAll('button')
    .find((button) => button.text() === text);
const editor = (wrapper) => wrapper.findComponent({ name: 'ShareDialog' });

beforeEach(() => {
  // The row's direct-link menu asks whether a file is editable, which reads a
  // store: without an active Pinia the whole row fails to render.
  setActivePinia(createPinia());
  [getMyShares, deleteShare, copyShareUrl, copyDirectShareFileUrl, fetchShareableUsers].forEach(
    (fn) => fn.mockReset()
  );
  deleteShare.mockResolvedValue({});
  copyShareUrl.mockResolvedValue();
  copyDirectShareFileUrl.mockResolvedValue();
  fetchShareableUsers.mockResolvedValue({ users: [] });
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

  it('shows both when asked for all of them', async () => {
    const wrapper = await open([
      share({ label: 'Still good', expiresAt: inTheFuture }),
      share({ label: 'Ran out', expiresAt: inThePast }),
    ]);

    await clickFilter(wrapper, 'All');

    expect(labels(wrapper)).toEqual(expect.arrayContaining(['Still good', 'Ran out']));
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

describe('who a link is shared with', () => {
  it('names up to three people and counts the others it could find', async () => {
    fetchShareableUsers.mockResolvedValue({
      users: [
        { id: 'u1', displayName: 'Ann' },
        { id: 'u2', username: 'bob' },
        { id: 'u3', displayName: 'Cid' },
        { id: 'u4', displayName: 'Dee' },
        { id: 'u5', displayName: 'Eve' },
      ],
    });
    const wrapper = await open([
      share({
        label: 'Team folder',
        sharingType: 'users',
        permittedUserIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'deleted-account'],
      }),
    ]);

    const text = row(wrapper, 'Team folder').text();
    expect(text).toContain('Ann');
    expect(text).toContain('bob');
    expect(text).toContain('Cid');
    expect(text).not.toContain('Dee');
    expect(text).toContain('+2');
  });

  it('still lists the links when the people cannot be looked up', async () => {
    fetchShareableUsers.mockRejectedValue(new Error('Forbidden'));
    const wrapper = await open([QUARTERLY]);

    expect(labels(wrapper)).toEqual(['Quarterly']);
    expect(wrapper.text()).not.toContain('Forbidden');
  });
});

describe('taking a link back', () => {
  it('asks before removing anything', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);
    expect(modal(wrapper).exists()).toBe(false);

    await row(wrapper, 'Holiday').find('[title="Remove"]').trigger('click');

    expect(modal(wrapper).exists()).toBe(true);
    expect(deleteShare).not.toHaveBeenCalled();
  });

  it('removes the link that was asked about, once confirmed, and only that one', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);

    await row(wrapper, 'Holiday').find('[title="Remove"]').trigger('click');
    await modalButton(wrapper, 'Delete').trigger('click');
    await flushPromises();

    expect(deleteShare).toHaveBeenCalledTimes(1);
    expect(deleteShare).toHaveBeenCalledWith('share-holiday');
    expect(labels(wrapper)).toEqual(['Quarterly']);
    expect(modal(wrapper).exists()).toBe(false);
  });

  it('removes nothing when cancelled, and asks afresh about the next one', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);

    await row(wrapper, 'Holiday').find('[title="Remove"]').trigger('click');
    await modalButton(wrapper, 'Cancel').trigger('click');

    expect(modal(wrapper).exists()).toBe(false);
    expect(deleteShare).not.toHaveBeenCalled();
    expect(labels(wrapper)).toEqual(['Holiday', 'Quarterly']);

    await row(wrapper, 'Quarterly').find('[title="Remove"]').trigger('click');
    await modalButton(wrapper, 'Delete').trigger('click');
    await flushPromises();

    expect(deleteShare).toHaveBeenCalledWith('share-quarterly');
    expect(labels(wrapper)).toEqual(['Holiday']);
  });

  it('cannot be cancelled or confirmed twice while the removal is under way', async () => {
    let finish;
    deleteShare.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const wrapper = await open([HOLIDAY]);

    await row(wrapper, 'Holiday').find('[title="Remove"]').trigger('click');
    await modalButton(wrapper, 'Delete').trigger('click');
    await flushPromises();

    expect(modalButton(wrapper, 'Cancel').attributes('disabled')).toBeDefined();
    expect(modalButton(wrapper, 'Deleting').attributes('disabled')).toBeDefined();

    finish({});
    await flushPromises();
    expect(modal(wrapper).exists()).toBe(false);
    expect(deleteShare).toHaveBeenCalledTimes(1);
  });

  it('says why a removal failed, and lets it be tried again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    deleteShare.mockRejectedValueOnce(new Error('Not your share'));
    const wrapper = await open([HOLIDAY]);

    await row(wrapper, 'Holiday').find('[title="Remove"]').trigger('click');
    await modalButton(wrapper, 'Delete').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Not your share');
    expect(modal(wrapper).exists()).toBe(true);
    // Not left saying "Deleting" with both buttons dead.
    expect(modal(wrapper).text()).not.toContain('Deleting');
    expect(modalButton(wrapper, 'Delete').attributes('disabled')).toBeUndefined();

    await modalButton(wrapper, 'Delete').trigger('click');
    await flushPromises();
    expect(deleteShare).toHaveBeenCalledTimes(2);
    expect(deleteShare).toHaveBeenLastCalledWith('share-holiday');
  });
});

describe('changing a link', () => {
  it('opens the editor on the link whose pencil was clicked', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);
    expect(editor(wrapper).props('modelValue')).toBe(false);

    await row(wrapper, 'Quarterly').find('[title="Edit share link"]').trigger('click');

    expect(editor(wrapper).props('modelValue')).toBe(true);
    expect(editor(wrapper).props('share')).toEqual(QUARTERLY);
  });

  it('opens the editor on a double-click on the row', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);

    await row(wrapper, 'Holiday').trigger('dblclick');

    expect(editor(wrapper).props('share')).toEqual(HOLIDAY);
  });

  it('shows the saved link and closes the editor once the change is saved', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);
    await row(wrapper, 'Holiday').find('[title="Edit share link"]').trigger('click');

    getMyShares.mockResolvedValue({ shares: [QUARTERLY, { ...HOLIDAY, label: 'Summer 2026' }] });
    editor(wrapper).vm.$emit('share-updated', { id: 'share-holiday' });
    await flushPromises();

    expect(getMyShares).toHaveBeenCalledTimes(2);
    expect(labels(wrapper)).toContain('Summer 2026');
    expect(editor(wrapper).props('modelValue')).toBe(false);
    expect(editor(wrapper).props('share')).toBe(null);
  });

  it('forgets the link when the editor is dismissed', async () => {
    const wrapper = await open([QUARTERLY]);
    await row(wrapper, 'Quarterly').find('[title="Edit share link"]').trigger('click');

    editor(wrapper).vm.$emit('update:modelValue', false);
    await flushPromises();

    expect(editor(wrapper).props('modelValue')).toBe(false);
    expect(editor(wrapper).props('share')).toBe(null);
  });
});

describe('the activity of a link', () => {
  it('shows the visits and downloads of the link asked about, and not another', async () => {
    const wrapper = await open([
      { ...QUARTERLY, accessCount: 11, lastAccessIp: '198.51.100.20' },
      {
        ...HOLIDAY,
        accessCount: 7,
        downloadCount: 3,
        lastAccessedAt: inThePast,
        lastAccessIp: '203.0.113.9',
      },
    ]);
    expect(wrapper.text()).not.toContain('203.0.113.9');

    await row(wrapper, 'Holiday').find('[title="Activity"]').trigger('click');

    const text = wrapper.text();
    expect(text).toContain('203.0.113.9');
    expect(text).toContain('7');
    expect(text).toContain('3');
    // Never downloaded: said so, rather than an invalid date or a blank.
    expect(text).toContain('Never happened');
    expect(text).toContain('No address recorded');
    expect(text).not.toContain('198.51.100.20');
  });

  it('goes away when closed', async () => {
    const wrapper = await open([{ ...HOLIDAY, lastAccessIp: '203.0.113.9' }]);
    await row(wrapper, 'Holiday').find('[title="Activity"]').trigger('click');

    await wrapper.find('[title="Close"]').trigger('click');

    expect(wrapper.text()).not.toContain('203.0.113.9');
  });
});

describe('copying a link', () => {
  it('copies the share page of the row clicked', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);

    await row(wrapper, 'Quarterly').find('[title="Copy share link"]').trigger('click');
    await flushPromises();

    expect(copyShareUrl).toHaveBeenCalledWith('tok-quarterly');
  });

  it('copies the direct link in the mode picked for that row only', async () => {
    const wrapper = await open([QUARTERLY, HOLIDAY]);

    await row(wrapper, 'Holiday').find('select').setValue('raw');
    await row(wrapper, 'Holiday').find('[title="Copy direct file link"]').trigger('click');
    await row(wrapper, 'Quarterly').find('[title="Copy direct file link"]').trigger('click');
    await flushPromises();

    expect(copyDirectShareFileUrl).toHaveBeenCalledWith('tok-holiday', '', 'raw');
    expect(copyDirectShareFileUrl).toHaveBeenCalledWith('tok-quarterly', '', 'auto');
  });

  it('offers the editor mode only for a file the editor can open', async () => {
    const wrapper = await open([
      share({ label: 'Notes', sourcePath: 'Docs/notes.txt' }),
      share({ label: 'Beach', sourcePath: 'Photos/beach.jpg' }),
      share({ label: 'Scripts', sourcePath: 'Code/scripts.txt', isDirectory: true }),
    ]);

    const modes = (label) =>
      row(wrapper, label)
        .findAll('option')
        .map((option) => option.attributes('value'));

    expect(modes('Notes')).toEqual(['auto', 'raw', 'editor']);
    expect(modes('Beach')).toEqual(['auto', 'raw']);
    expect(modes('Scripts')).toEqual(['auto', 'raw']);
  });
});

describe('when there is nothing, or nothing works', () => {
  it('says nothing was found rather than showing an empty page', async () => {
    const wrapper = await open([]);

    expect(wrapper.text()).toContain('Nothing to show');
  });

  it('reports a failure and offers to try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getMyShares.mockRejectedValue(new Error('Network down'));
    const wrapper = mount(SharedByMeView, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Network down');
    expect(wrapper.text()).toContain('Try again');
  });

  it('loads the list again when asked to try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getMyShares.mockRejectedValueOnce(new Error('Network down'));
    getMyShares.mockResolvedValue({ shares: [HOLIDAY] });
    const wrapper = mount(SharedByMeView, { global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Try again')
      .trigger('click');
    await flushPromises();

    expect(labels(wrapper)).toEqual(['Holiday']);
    expect(wrapper.text()).not.toContain('Network down');
  });
});
