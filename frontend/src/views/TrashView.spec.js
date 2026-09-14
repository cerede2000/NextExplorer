import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

/**
 * The trash screen. The server decides what each person sees and whether a
 * restore is allowed; this screen has to show what came back — including what
 * was refused, and why — and never delete anything for good without asking.
 */

const getTrash = vi.fn();
const restoreTrashItems = vi.fn();
const deleteTrashItems = vi.fn();
const emptyTrash = vi.fn();
const addNotification = vi.fn();
const push = vi.fn();

vi.mock('@/api', () => ({
  getTrash: (...args) => getTrash(...args),
  restoreTrashItems: (...args) => restoreTrashItems(...args),
  deleteTrashItems: (...args) => deleteTrashItems(...args),
  emptyTrash: (...args) => emptyTrash(...args),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification }),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIcon', props: ['item'], template: '<i />' },
}));

import TrashView from './TrashView.vue';

const DAY = 24 * 60 * 60 * 1000;

const item = (overrides = {}) => ({
  id: 'id-report',
  name: 'report.txt',
  kind: 'file',
  size: 2048,
  deletedAt: new Date(Date.now() - DAY).toISOString(),
  expiresAt: new Date(Date.now() + 12 * DAY + 60_000).toISOString(),
  deletedBy: { id: 'u1', label: 'Alice', isYou: true },
  location: { kind: 'volume', name: 'Projects', parent: 'a/b' },
  openPath: 'Projects/a/b',
  available: true,
  ...overrides,
});

let wrapper;

const open = async (response) => {
  getTrash.mockResolvedValue(response);
  wrapper = mount(TrashView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
};

const rows = () => wrapper.findAll('[data-trash-row]');
const click = async (selector) => {
  await wrapper.get(selector).trigger('click');
  await flushPromises();
};
const dialogText = () =>
  document.body.querySelector('[data-test="trash-confirm-message"]')?.textContent;
const confirmDialog = async () => {
  document.body.querySelector('[data-test="trash-confirm"]').click();
  await flushPromises();
};

beforeEach(() => {
  [getTrash, restoreTrashItems, deleteTrashItems, emptyTrash, addNotification, push].forEach(
    (mock) => mock.mockReset()
  );
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});

describe('what the trash shows', () => {
  it('lists each item with where it was, who deleted it and when it goes', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });

    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row.get('[data-trash-name]').text()).toBe('report.txt');
    expect(row.get('[data-trash-location]').text()).toBe('Projects / a/b');
    expect(row.get('[data-trash-deleted-by]').text()).toBe('trash.deletedBy.you');
    expect(row.get('[data-trash-expires]').text()).toBe('trash.expiresIn {"count":13}');
    expect(wrapper.text()).toContain('trash.subtitle {"count":30}');
  });

  it('names a personal folder, a share link and someone else in their own words', async () => {
    await open({
      enabled: true,
      retentionDays: 30,
      items: [
        item({ id: 'a', location: { kind: 'personal', name: 'u1', parent: '' } }),
        item({ id: 'b', deletedBy: { id: null, label: 'share-link', isYou: false } }),
        item({ id: 'c', deletedBy: { id: 'u2', label: 'Bob', isYou: false } }),
      ],
    });

    expect(rows()[0].get('[data-trash-location]').text()).toBe('trash.location.personal');
    expect(rows()[1].get('[data-trash-deleted-by]').text()).toBe('trash.deletedBy.shareLink');
    expect(rows()[2].get('[data-trash-deleted-by]').text()).toBe('Bob');
  });

  it('says an item goes today rather than in zero days', async () => {
    await open({
      enabled: true,
      retentionDays: 30,
      items: [item({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
    });

    expect(rows()[0].get('[data-trash-expires]').text()).toBe('trash.expiresToday');
  });

  it('marks an item whose volume is not there', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item({ available: false })] });

    expect(rows()[0].find('[data-test="trash-unavailable"]').exists()).toBe(true);
  });

  it('says so when it is empty', async () => {
    await open({ enabled: true, retentionDays: 30, items: [] });

    expect(wrapper.find('[data-test="trash-empty-state"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="trash-empty"]').attributes('disabled')).toBeDefined();
  });

  it('says deleting is permanent while the trash is off', async () => {
    await open({ enabled: false, retentionDays: 30, items: [] });

    expect(wrapper.find('[data-test="trash-disabled"]').exists()).toBe(true);
  });

  it('says what went wrong when it cannot load, and tries again', async () => {
    getTrash.mockRejectedValueOnce(new Error('Server unreachable'));
    wrapper = mount(TrashView, { attachTo: document.body });
    await flushPromises();

    expect(wrapper.get('[data-test="trash-error"]').text()).toContain('Server unreachable');

    getTrash.mockResolvedValueOnce({ enabled: true, retentionDays: 30, items: [item()] });
    await wrapper.get('[data-test="trash-error"] button').trigger('click');
    await flushPromises();
    expect(rows()).toHaveLength(1);
  });
});

describe('restoring', () => {
  it('restores what is selected, says where, and reloads', async () => {
    await open({
      enabled: true,
      retentionDays: 30,
      items: [item(), item({ id: 'other', name: 'other.txt' })],
    });
    restoreTrashItems.mockResolvedValue({
      items: [
        {
          id: 'id-report',
          status: 'restored',
          name: 'report.txt',
          restoredName: 'report.txt',
          renamed: false,
          path: 'Projects/a/b',
        },
      ],
    });
    getTrash.mockResolvedValue({ enabled: true, retentionDays: 30, items: [] });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');

    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report']);
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        heading: 'trash.results.restored {"count":1}',
        body: 'trash.results.restoredTo {"path":"Projects/a/b"}',
      })
    );
    expect(getTrash).toHaveBeenCalledTimes(2);
  });

  it('says when an item came back under another name', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    restoreTrashItems.mockResolvedValue({
      items: [
        {
          id: 'id-report',
          status: 'restored',
          name: 'report.txt',
          restoredName: 'report (1).txt',
          renamed: true,
          path: null,
        },
      ],
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');

    expect(addNotification.mock.calls[0][0].body).toContain('"newName":"report (1).txt"');
  });

  it('says which items could not come back, and why', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    restoreTrashItems.mockResolvedValue({
      items: [{ id: 'id-report', status: 'forbidden', name: 'report.txt' }],
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        heading: 'trash.results.notRestored {"count":1}',
        body: 'report.txt: trash.reasons.forbidden',
      })
    );
  });

  it('cannot be asked for with nothing selected', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });

    expect(wrapper.get('[data-test="trash-restore"]').attributes('disabled')).toBeDefined();
  });

  it('selects everything at once, and nothing on a second go', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item(), item({ id: 'b' })] });
    restoreTrashItems.mockResolvedValue({ items: [] });

    await wrapper.get('[data-test="trash-select-all"]').trigger('change');
    await click('[data-test="trash-restore"]');
    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report', 'b']);
  });
});

describe('deleting for good', () => {
  it('asks first, and deletes only once confirmed', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    deleteTrashItems.mockResolvedValue({
      items: [{ id: 'id-report', status: 'purged', name: 'report.txt' }],
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-delete"]');

    expect(deleteTrashItems).not.toHaveBeenCalled();
    expect(dialogText()).toContain('trash.confirm.deleteMessage {"count":1}');

    await confirmDialog();

    expect(deleteTrashItems).toHaveBeenCalledWith(['id-report']);
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', heading: 'trash.results.deleted {"count":1}' })
    );
  });

  it('empties the trash only once confirmed, and says if something stayed', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    emptyTrash.mockResolvedValue({ purged: 3, unavailable: 1, failed: 0 });

    await click('[data-test="trash-empty"]');
    expect(emptyTrash).not.toHaveBeenCalled();
    expect(dialogText()).toContain('trash.confirm.emptyMessage');

    await confirmDialog();

    expect(emptyTrash).toHaveBeenCalled();
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        heading: 'trash.results.emptied {"count":3}',
        body: 'trash.results.leftBehind {"count":1}',
      })
    );
  });

  it('says so when the server refuses the whole request', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    emptyTrash.mockRejectedValue(new Error('Gateway timeout'));

    await click('[data-test="trash-empty"]');
    await confirmDialog();

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', body: 'Gateway timeout' })
    );
  });
});

describe('the original location', () => {
  it('opens the folder the item came from', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });

    await wrapper.get('[data-test="trash-open-location"]').trigger('click');

    expect(push).toHaveBeenCalledWith({ name: 'FolderView', params: { path: 'Projects/a/b' } });
  });

  it('offers nothing to open when this person cannot reach it', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item({ openPath: null })] });

    expect(wrapper.find('[data-test="trash-open-location"]').exists()).toBe(false);
  });
});
