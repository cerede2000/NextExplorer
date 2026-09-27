import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The trash screen. The server decides what each person sees and whether a
 * restore is allowed; this screen has to show what came back — including what
 * was refused, and why — and never delete anything for good without asking.
 */

const getTrash = vi.fn();
const getTrashEntries = vi.fn();
const restoreTrashItems = vi.fn();
const restoreTrashEntries = vi.fn();
const restoreTrashItemsTo = vi.fn();
const restoreTrashEntriesTo = vi.fn();
const deleteTrashItems = vi.fn();
const emptyTrash = vi.fn();
const addNotification = vi.fn();
const push = vi.fn();
const pick = vi.fn();
const startOperation = vi.fn();
const updateOperation = vi.fn();
const finishOperation = vi.fn();
const route = reactive({ query: {} });

vi.mock('@/api', () => ({
  getTrash: (...args) => getTrash(...args),
  getTrashEntries: (...args) => getTrashEntries(...args),
  restoreTrashItems: (...args) => restoreTrashItems(...args),
  restoreTrashEntries: (...args) => restoreTrashEntries(...args),
  restoreTrashItemsTo: (...args) => restoreTrashItemsTo(...args),
  restoreTrashEntriesTo: (...args) => restoreTrashEntriesTo(...args),
  deleteTrashItems: (...args) => deleteTrashItems(...args),
  emptyTrash: (...args) => emptyTrash(...args),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({ startOperation, updateOperation, finishOperation }),
}));
vi.mock('@/composables/useDestinationPicker', () => ({
  useDestinationPicker: () => ({ pick }),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => route }));
const translate = (key, params) =>
  params && typeof params === 'object' ? `${key} ${JSON.stringify(params)}` : key;
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIcon', props: ['item'], template: '<i />' },
}));
vi.mock('@/config/editor', () => ({
  isEditableExtension: (extension) => ['txt', 'sh', 'md'].includes(extension),
}));
vi.mock('@floating-ui/vue', () => ({
  useFloating: () => ({ floatingStyles: {}, update: () => {} }),
  autoUpdate: () => {},
  flip: () => {},
  offset: () => {},
  shift: () => {},
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
  [
    getTrash,
    getTrashEntries,
    restoreTrashItems,
    restoreTrashEntries,
    restoreTrashItemsTo,
    restoreTrashEntriesTo,
    deleteTrashItems,
    emptyTrash,
    addNotification,
    push,
    pick,
    startOperation,
    updateOperation,
    finishOperation,
  ].forEach((mock) => mock.mockReset());
  route.query = {};
  // As the router does: the address changes, and the screen follows it.
  push.mockImplementation(async (to) => {
    route.query = to.query || {};
  });
  startOperation.mockReturnValue('op-1');
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
    expect(getTrashEntries).not.toHaveBeenCalled();
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

    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report'], {});
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
    expect(wrapper.get('[data-test="trash-restore-to"]').attributes('disabled')).toBeDefined();
  });

  it('selects everything at once, and nothing on a second go', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item(), item({ id: 'b' })] });
    restoreTrashItems.mockResolvedValue({ items: [] });

    await wrapper.get('[data-test="trash-select-all"]').trigger('change');
    await click('[data-test="trash-restore"]');
    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report', 'b'], {});
  });
});

describe('restoring somewhere else', () => {
  const restored = (overrides = {}) => ({
    id: 'id-report',
    status: 'restored',
    name: 'report.txt',
    restoredName: 'report.txt',
    renamed: false,
    path: 'Archive',
    ...overrides,
  });

  it('asks where, restores the selection there as a task, and says where it went', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    pick.mockResolvedValue('Archive');
    restoreTrashItemsTo.mockImplementation(async (_ids, _destination, { onEvent }) => {
      onEvent({ type: 'start', totalBytes: 2048, totalItems: 1, destination: 'Archive' });
      onEvent({
        type: 'progress',
        copiedBytes: 1024,
        totalBytes: 2048,
        currentName: 'report.txt',
        completedItems: 0,
      });
      return { type: 'done', destination: 'Archive', items: [restored()] };
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore-to"]');

    expect(pick).toHaveBeenCalledWith({ mode: 'restore' });
    expect(restoreTrashItemsTo).toHaveBeenCalledWith(
      ['id-report'],
      'Archive',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'restore',
        itemCount: 1,
        destination: 'Archive',
        cancellable: true,
      })
    );
    expect(updateOperation).toHaveBeenCalledWith('op-1', { totalBytes: 2048, copiedBytes: 1024 });
    expect(finishOperation).toHaveBeenCalledWith('op-1');
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        body: 'trash.results.restoredTo {"path":"Archive"}',
      })
    );
    expect(getTrash).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no folder is chosen', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    pick.mockResolvedValue(null);

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore-to"]');

    expect(restoreTrashItemsTo).not.toHaveBeenCalled();
    expect(startOperation).not.toHaveBeenCalled();
  });

  it('says why the chosen folder turned an item away', async () => {
    await open({
      enabled: true,
      retentionDays: 30,
      items: [item(), item({ id: 'b', name: 'b.txt' })],
    });
    pick.mockResolvedValue('Archive');
    restoreTrashItemsTo.mockResolvedValue({
      destination: 'Archive',
      items: [
        { id: 'id-report', status: 'forbidden', reason: 'destination', name: 'report.txt' },
        { id: 'b', status: 'blocked', reason: 'invalid-destination', name: 'b.txt' },
      ],
    });

    await wrapper.get('[data-test="trash-select-all"]').trigger('change');
    await click('[data-test="trash-restore-to"]');

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        body: 'report.txt: trash.reasons.destinationForbidden\nb.txt: trash.reasons.invalidDestination',
      })
    );
  });

  it('stops quietly when the task is cancelled, and shows what is really left', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    pick.mockResolvedValue('Archive');
    restoreTrashItemsTo.mockImplementation(async (_ids, _destination, { signal }) => {
      startOperation.mock.calls[0][0].cancel();
      expect(signal.aborted).toBe(true);
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore-to"]');

    expect(addNotification).not.toHaveBeenCalled();
    expect(finishOperation).toHaveBeenCalledWith('op-1');
    expect(getTrash).toHaveBeenCalledTimes(2);
  });

  it('says so when the server fails the restore outright', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item()] });
    pick.mockResolvedValue('Archive');
    restoreTrashItemsTo.mockRejectedValue(new Error('The destination must be an existing folder.'));

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore-to"]');

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        body: 'The destination must be an existing folder.',
      })
    );
    expect(finishOperation).toHaveBeenCalledWith('op-1');
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

    expect(push).toHaveBeenCalledWith({ path: '/browse/Projects/a/b' });
  });

  it('offers nothing to open when this person cannot reach it', async () => {
    await open({ enabled: true, retentionDays: 30, items: [item({ openPath: null })] });

    expect(wrapper.find('[data-test="trash-open-location"]').exists()).toBe(false);
  });
});

describe('inside a deleted folder', () => {
  const folderItem = item({
    id: 'id-client',
    name: 'client',
    kind: 'directory',
    size: 30,
    location: { kind: 'volume', name: 'Projects', parent: '' },
  });
  const entry = (name, overrides = {}) => ({
    name,
    kind: 'file',
    size: 12,
    modifiedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  });
  const listing = (path = '', entries = null) => ({
    item: folderItem,
    path,
    entries: entries || [
      entry('drafts', { kind: 'directory', size: null }),
      entry('brief.txt', { size: 9 }),
    ],
  });
  const openInside = async (query, response = listing(query.path || '')) => {
    route.query = query;
    getTrashEntries.mockResolvedValue(response);
    return open({ enabled: true, retentionDays: 30, items: [folderItem] });
  };
  const entryRows = () => wrapper.findAll('[data-trash-entry]');
  const entryNames = () => entryRows().map((row) => row.get('[data-trash-entry-name]').text());

  it('opens from the list by the folder’s name, and only for a folder that is there', async () => {
    getTrashEntries.mockResolvedValue(listing());
    await open({
      enabled: true,
      retentionDays: 30,
      items: [
        folderItem,
        item(),
        item({ id: 'gone', name: 'gone', kind: 'directory', available: false }),
      ],
    });

    expect(wrapper.findAll('[data-test="trash-open-folder"]')).toHaveLength(1);

    await click('[data-test="trash-open-folder"]');

    expect(push).toHaveBeenCalledWith({ name: 'Trash', query: { item: 'id-client' } });
    expect(getTrashEntries).toHaveBeenCalledWith('id-client', '');
    expect(entryNames()).toEqual(['drafts', 'brief.txt']);
    // Opening is not selecting.
    expect(rows()).toHaveLength(0);
  });

  it('shows where it is, what the folder holds, and where the folder was deleted from', async () => {
    await openInside(
      { item: 'id-client', path: 'drafts/old' },
      listing('drafts/old', [entry('v1.txt')])
    );

    expect(getTrashEntries).toHaveBeenCalledWith('id-client', 'drafts/old');
    expect(wrapper.get('[data-test="trash-crumb-root"]').text()).toBe('trash.title');
    expect(wrapper.findAll('[data-test="trash-crumb"]').map((crumb) => crumb.text())).toEqual([
      'client',
      'drafts',
    ]);
    expect(wrapper.get('[data-test="trash-crumb-current"]').text()).toBe('old');
    expect(wrapper.get('[data-test="trash-folder-info"]').text()).toContain(
      'trash.browse.deletedFrom {"location":"Projects"'
    );
    expect(entryNames()).toEqual(['v1.txt']);
  });

  it('shows no size for a folder inside it, and offers nothing that deletes for good', async () => {
    await openInside({ item: 'id-client' });

    expect(entryRows()[0].get('[data-trash-entry-size]').text()).toBe('—');
    expect(wrapper.find('[data-test="trash-delete"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="trash-empty"]').exists()).toBe(false);
  });

  it('goes further in by a folder’s name, and back up by the path above', async () => {
    await openInside({ item: 'id-client' });

    getTrashEntries.mockResolvedValue(listing('drafts', [entry('v1.txt')]));
    await click('[data-test="trash-open-entry"]');
    expect(push).toHaveBeenLastCalledWith({
      name: 'Trash',
      query: { item: 'id-client', path: 'drafts' },
    });
    expect(getTrashEntries).toHaveBeenLastCalledWith('id-client', 'drafts');
    expect(entryNames()).toEqual(['v1.txt']);

    getTrashEntries.mockResolvedValue(listing());
    await click('[data-test="trash-crumb"]');
    expect(push).toHaveBeenLastCalledWith({ name: 'Trash', query: { item: 'id-client' } });

    await click('[data-test="trash-crumb-root"]');
    expect(push).toHaveBeenLastCalledWith({ name: 'Trash', query: {} });
    expect(rows()).toHaveLength(1);
  });

  it('restores what is selected inside it, each to its place, and stays in the folder', async () => {
    await openInside(
      { item: 'id-client', path: 'drafts' },
      listing('drafts', [entry('v1.txt'), entry('v2.txt')])
    );
    restoreTrashEntries.mockResolvedValue({
      items: [
        {
          entry: 'drafts/v2.txt',
          status: 'restored',
          name: 'v2.txt',
          restoredName: 'v2.txt',
          renamed: false,
          path: 'Projects/client/drafts',
        },
      ],
    });

    expect(wrapper.get('[data-test="trash-restore-entries"]').attributes('disabled')).toBeDefined();
    await entryRows()[1].trigger('click');
    await click('[data-test="trash-restore-entries"]');

    expect(restoreTrashEntries).toHaveBeenCalledWith('id-client', ['drafts/v2.txt'], {});
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        heading: 'trash.results.restored {"count":1}',
        body: 'trash.results.restoredTo {"path":"Projects/client/drafts"}',
      })
    );
    expect(getTrashEntries).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it('restores what is selected inside it into a folder chosen elsewhere', async () => {
    await openInside(
      { item: 'id-client', path: 'drafts' },
      listing('drafts', [entry('v1.txt'), entry('v2.txt')])
    );
    pick.mockResolvedValue('Archive');
    restoreTrashEntriesTo.mockResolvedValue({
      destination: 'Archive',
      items: [
        {
          entry: 'drafts/v2.txt',
          status: 'restored',
          name: 'v2.txt',
          restoredName: 'v2.txt',
          renamed: false,
          path: 'Archive',
        },
      ],
    });

    expect(
      wrapper.get('[data-test="trash-restore-entries-to"]').attributes('disabled')
    ).toBeDefined();
    await entryRows()[1].trigger('click');
    await click('[data-test="trash-restore-entries-to"]');

    expect(restoreTrashEntriesTo).toHaveBeenCalledWith(
      'id-client',
      ['drafts/v2.txt'],
      'Archive',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'trash.results.restoredTo {"path":"Archive"}' })
    );
    expect(getTrashEntries).toHaveBeenCalledTimes(2);
  });

  it('restores everything shown at once, and says what could not come back and why', async () => {
    await openInside({ item: 'id-client' });
    restoreTrashEntries.mockResolvedValue({
      items: [
        { entry: 'drafts', status: 'blocked', reason: 'destination-blocked', name: 'drafts' },
        { entry: 'brief.txt', status: 'restored', name: 'brief.txt', renamed: false, path: null },
      ],
    });

    await wrapper.get('[data-test="trash-select-all-entries"]').trigger('change');
    await click('[data-test="trash-restore-entries"]');

    expect(restoreTrashEntries).toHaveBeenCalledWith('id-client', ['drafts', 'brief.txt'], {});
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        heading: 'trash.results.notRestored {"count":1}',
        body: 'drafts: trash.reasons.blocked',
      })
    );
  });

  it('restores the whole folder, and returns to the list', async () => {
    await openInside({ item: 'id-client', path: 'drafts' });
    restoreTrashItems.mockResolvedValue({
      items: [
        {
          id: 'id-client',
          status: 'restored',
          name: 'client',
          restoredName: 'client',
          renamed: false,
          path: 'Projects',
        },
      ],
    });

    await click('[data-test="trash-restore-folder"]');

    expect(restoreTrashItems).toHaveBeenCalledWith(['id-client'], {});
    expect(push).toHaveBeenCalledWith({ name: 'Trash', query: {} });
  });

  it('stays in the folder when the whole folder could not come back', async () => {
    await openInside({ item: 'id-client' });
    restoreTrashItems.mockResolvedValue({
      items: [{ id: 'id-client', status: 'forbidden', name: 'client' }],
    });

    await click('[data-test="trash-restore-folder"]');

    expect(push).not.toHaveBeenCalled();
    expect(entryNames()).toEqual(['drafts', 'brief.txt']);
  });

  it('says so when the folder is empty', async () => {
    await openInside({ item: 'id-client' }, listing('', []));

    expect(wrapper.find('[data-test="trash-folder-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="trash-folder-hint"]').exists()).toBe(false);
  });

  it('says what went wrong when it cannot be opened, and leads back to the trash', async () => {
    route.query = { item: 'gone' };
    getTrashEntries.mockRejectedValue(new Error('This item is not in your trash.'));
    await open({ enabled: true, retentionDays: 30, items: [item()] });

    expect(wrapper.get('[data-test="trash-folder-error"]').text()).toContain(
      'This item is not in your trash.'
    );

    await click('[data-test="trash-folder-back"]');

    expect(push).toHaveBeenCalledWith({ name: 'Trash', query: {} });
    expect(wrapper.find('[data-test="trash-folder-error"]').exists()).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it('shows the folder it is in now, not one it was in a moment ago', async () => {
    let answerSlowly;
    getTrashEntries
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerSlowly = resolve;
          })
      )
      .mockResolvedValueOnce(listing('drafts', [entry('v1.txt')]));
    route.query = { item: 'id-client' };
    await open({ enabled: true, retentionDays: 30, items: [folderItem] });

    route.query = { item: 'id-client', path: 'drafts' };
    await flushPromises();
    answerSlowly(listing());
    await flushPromises();

    expect(entryNames()).toEqual(['v1.txt']);
  });
});

/**
 * The right-click menu, a long press, the menu key and a double click: the ways
 * to act on one row without reaching for the toolbar. A right click on a row
 * that is not selected acts on that row alone; on a selection, on all of it.
 */
describe('the right-click menu', () => {
  const menu = () => document.body.querySelector('[role="menu"]');
  const menuEntries = () =>
    [...document.body.querySelectorAll('[role="menuitem"]')].map((entry) =>
      entry.textContent.trim()
    );
  const choose = async (label) => {
    [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent.trim() === label)
      .click();
    await flushPromises();
  };
  const rightClick = async (row) => {
    await row.trigger('contextmenu', { clientX: 100, clientY: 120 });
    await flushPromises();
  };
  const openList = (items) => open({ enabled: true, retentionDays: 30, items });

  it('offers what a deleted file allows, and acts on that file alone', async () => {
    await openList([item({ name: 'notes.txt' }), item({ id: 'b', name: 'b.txt' })]);
    await rows()[1].trigger('click');

    await rightClick(rows()[0]);

    expect(menu().getAttribute('aria-label')).toBe('trash.contextMenu.label {"name":"notes.txt"}');
    expect(menuEntries()).toEqual([
      'trash.contextMenu.preview',
      'trash.actions.restore',
      'trash.actions.restoreTo',
      'trash.actions.openLocation',
      'trash.actions.deletePermanently',
    ]);

    restoreTrashItems.mockResolvedValue({ items: [] });
    await choose('trash.actions.restore');
    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report'], {});
    expect(menu()).toBeNull();
  });

  it('keeps the selection it was opened on, and offers only what applies to all of it', async () => {
    await openList([item(), item({ id: 'b', name: 'b.txt' })]);
    await wrapper.get('[data-test="trash-select-all"]').trigger('change');

    await rightClick(rows()[0]);

    expect(menu().getAttribute('aria-label')).toBe('trash.contextMenu.labelMany {"count":2}');
    expect(menuEntries()).toEqual([
      'trash.actions.restore',
      'trash.actions.restoreTo',
      'trash.actions.deletePermanently',
    ]);
    // Deleting for good still asks first.
    await choose('trash.actions.deletePermanently');
    expect(dialogText()).toContain('trash.confirm.deleteMessage {"count":2}');
    expect(deleteTrashItems).not.toHaveBeenCalled();
  });

  it('opens a deleted folder from the menu', async () => {
    getTrashEntries.mockResolvedValue({ item: item(), path: '', entries: [] });
    await openList([item({ id: 'id-client', name: 'client', kind: 'directory' })]);

    await rightClick(rows()[0]);
    expect(menuEntries()[0]).toBe('trash.contextMenu.open');
    await choose('trash.contextMenu.open');

    expect(push).toHaveBeenCalledWith({ name: 'Trash', query: { item: 'id-client' } });
  });

  it('reads a file in the editor, read only, from the menu or by a double click', async () => {
    await openList([item({ id: 'id-sh', name: 'run.sh' })]);
    const viewer = { name: 'TrashFileViewer', params: { itemId: 'id-sh', entryPath: [] } };

    await rightClick(rows()[0]);
    await choose('trash.contextMenu.preview');
    expect(push).toHaveBeenCalledWith(viewer);

    push.mockClear();
    await rows()[0].trigger('dblclick');
    expect(push).toHaveBeenCalledWith(viewer);
  });

  it('offers no preview of what the editor cannot show, and nothing to open on a missing volume', async () => {
    await openList([
      item({ name: 'photo.jpg' }),
      item({ id: 'gone', name: 'gone', kind: 'directory', available: false }),
    ]);

    await rightClick(rows()[0]);
    expect(menuEntries()).not.toContain('trash.contextMenu.preview');
    await rightClick(rows()[1]);
    expect(menuEntries()).not.toContain('trash.contextMenu.open');

    await rows()[1].trigger('dblclick');
    await rows()[0].trigger('dblclick');
    expect(push).not.toHaveBeenCalled();
  });

  it('opens from the keyboard, with the menu key on a row', async () => {
    await openList([item()]);

    await rows()[0].get('input[type="checkbox"]').trigger('keydown', { key: 'ContextMenu' });
    await flushPromises();

    expect(menuEntries()).toContain('trash.actions.restore');
  });

  it('opens on a long press on a touch screen, without the lifted finger unselecting the row', async () => {
    await openList([item()]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await rows()[0].trigger('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 });
      vi.advanceTimersByTime(500);
      await flushPromises();
      expect(menuEntries()).toContain('trash.actions.restore');

      await rows()[0].trigger('click');
      expect(wrapper.get('[data-test="trash-restore"]').attributes('disabled')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open on a press that moves, as a scroll does', async () => {
    await openList([item()]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await rows()[0].trigger('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 });
      await rows()[0].trigger('pointermove', { pointerType: 'touch', clientX: 20, clientY: 80 });
      vi.advanceTimersByTime(600);
      await flushPromises();

      expect(menu()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers reading and restoring for what is inside a deleted folder', async () => {
    route.query = { item: 'id-client', path: 'drafts' };
    getTrashEntries.mockResolvedValue({
      item: item({ id: 'id-client', name: 'client', kind: 'directory' }),
      path: 'drafts',
      entries: [{ name: 'v1.txt', kind: 'file', size: 5, modifiedAt: '2026-09-01T10:00:00.000Z' }],
    });
    await openList([]);

    await wrapper.get('[data-trash-entry]').trigger('contextmenu', { clientX: 5, clientY: 5 });
    await flushPromises();

    expect(menuEntries()).toEqual([
      'trash.contextMenu.preview',
      'trash.actions.restore',
      'trash.actions.restoreTo',
    ]);
    await choose('trash.contextMenu.preview');
    expect(push).toHaveBeenCalledWith({
      name: 'TrashFileViewer',
      params: { itemId: 'id-client', entryPath: ['drafts', 'v1.txt'] },
    });
  });
});

/**
 * Share links kept with what went to the trash. Restoring asks what becomes of
 * them — only when there are some — and nothing is restored when the question
 * is closed; deleting for good says they go too.
 */
describe('share links kept in the trash', () => {
  const openList = (list) => open({ enabled: true, retentionDays: 30, items: list });
  const shared = (overrides = {}) => item({ shareCount: 2, ...overrides });
  const question = () => document.body.querySelector('[data-test="trash-shares-message"]');
  const answer = async (testId) => {
    document.body.querySelector(`[data-test="${testId}"]`).click();
    await flushPromises();
  };
  const restored = (overrides = {}) => ({
    id: 'id-report',
    status: 'restored',
    name: 'report.txt',
    restoredName: 'report.txt',
    renamed: false,
    path: 'Projects/a/b',
    ...overrides,
  });

  it('marks an item that had share links', async () => {
    await openList([shared(), item({ id: 'b', name: 'b.txt' })]);

    expect(rows()[0].get('[data-test="trash-shared"]').attributes('title')).toBe(
      'trash.shares.badgeTitle {"count":2}'
    );
    expect(rows()[1].find('[data-test="trash-shared"]').exists()).toBe(false);
  });

  it('asks what becomes of the links before restoring, and brings them back when told to', async () => {
    await openList([shared()]);
    restoreTrashItems.mockResolvedValue({
      items: [restored({ sharesRestored: 2, sharesDropped: 0 })],
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');

    expect(restoreTrashItems).not.toHaveBeenCalled();
    expect(question().textContent).toContain('trash.shares.chooseMessage {"count":2}');
    expect(document.body.querySelector('[data-test="trash-shares-elsewhere"]')).toBeNull();

    await answer('trash-shares-keep');

    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report'], { shares: 'restore' });
    expect(addNotification.mock.calls[0][0].body).toContain('trash.shares.restored {"count":2}');
    expect(question()).toBeNull();
  });

  it('lets the links go when told to', async () => {
    await openList([shared()]);
    restoreTrashItems.mockResolvedValue({
      items: [restored({ sharesRestored: 0, sharesDropped: 2 })],
    });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');
    await answer('trash-shares-drop');

    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report'], { shares: 'drop' });
    expect(addNotification.mock.calls[0][0].body).toContain('trash.shares.dropped {"count":2}');
  });

  it('restores nothing when the question is closed', async () => {
    await openList([shared()]);

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');
    await answer('trash-shares-cancel');

    expect(restoreTrashItems).not.toHaveBeenCalled();
    expect(question()).toBeNull();
  });

  it('asks nothing when nothing had share links', async () => {
    await openList([item()]);
    restoreTrashItems.mockResolvedValue({ items: [] });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore"]');

    expect(question()).toBeNull();
    expect(restoreTrashItems).toHaveBeenCalledWith(['id-report'], {});
  });

  it('says the links will follow when restoring somewhere else', async () => {
    await openList([shared()]);
    pick.mockResolvedValue('Archive');
    restoreTrashItemsTo.mockResolvedValue({ destination: 'Archive', items: [] });

    await rows()[0].trigger('click');
    await click('[data-test="trash-restore-to"]');

    expect(document.body.querySelector('[data-test="trash-shares-elsewhere"]')).not.toBeNull();
    await answer('trash-shares-keep');

    expect(restoreTrashItemsTo).toHaveBeenCalledWith(
      ['id-report'],
      'Archive',
      expect.objectContaining({ shares: 'restore' })
    );
  });

  it('asks about the links of the entries restored out of a deleted folder, and only those', async () => {
    route.query = { item: 'id-client' };
    const entry = (name, shareCount) => ({
      name,
      kind: 'file',
      size: 2,
      modifiedAt: '2026-09-01T10:00:00.000Z',
      shareCount,
    });
    getTrashEntries.mockResolvedValue({
      item: item({ id: 'id-client', name: 'client', kind: 'directory', shareCount: 1 }),
      path: '',
      entries: [entry('v1.txt', 1), entry('b.txt', 0)],
    });
    restoreTrashEntries.mockResolvedValue({ items: [] });
    await openList([]);
    const entryRows = () => wrapper.findAll('[data-trash-entry]');

    expect(entryRows()[0].find('[data-test="trash-shared"]').exists()).toBe(true);
    await entryRows()[1].trigger('click');
    await click('[data-test="trash-restore-entries"]');
    expect(question()).toBeNull();
    expect(restoreTrashEntries).toHaveBeenLastCalledWith('id-client', ['b.txt'], {});

    await entryRows()[1].trigger('click');
    await entryRows()[0].trigger('click');
    await click('[data-test="trash-restore-entries"]');
    expect(question().textContent).toContain('"count":1');
    await answer('trash-shares-drop');
    expect(restoreTrashEntries).toHaveBeenLastCalledWith('id-client', ['v1.txt'], {
      shares: 'drop',
    });
  });

  it('says the links go for good with what is deleted for good', async () => {
    await openList([shared()]);

    await rows()[0].trigger('click');
    await click('[data-test="trash-delete"]');

    expect(dialogText()).toContain('trash.shares.deleteNotice');
  });
});
