import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The administrator's list of files that have a history.
 *
 * The page exists to answer two questions — what is taking the space, and can
 * it go — so what is worth holding is that a filter starts a new page rather
 * than paging through the old one, that deleting asks first, and that after a
 * deletion both the row and the versions under it are read again. A row
 * saying three versions above a list of one is the failure this page would
 * have.
 */

const api = vi.hoisted(() => ({
  getVersionedFiles: vi.fn(),
  getVersionedFile: vi.fn(),
  deleteVersionsOfFile: vi.fn(),
}));
vi.mock('@/api', () => api);

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));

vi.mock('@/components/ModalDialog.vue', () => ({
  default: {
    name: 'ModalDialog',
    props: ['modelValue'],
    template: '<div v-if="modelValue" data-test="dialog"><slot name="title" /><slot /></div>',
  },
}));

const SettingsFileVersions = (await import('./SettingsFileVersions.vue')).default;

const page = (files, extra = {}) => ({
  files,
  total: files.length,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  totalVersions: files.reduce((sum, file) => sum + file.versions, 0),
  limit: 25,
  offset: 0,
  zones: [{ id: 'z1', kind: 'volume', name: 'Projects' }],
  states: ['live', 'trashed', 'orphaned'],
  sorts: ['bytes', 'versions', 'newest', 'path'],
  ...extra,
});

const NOTES = {
  id: 'f1',
  name: 'notes.md',
  relativePath: 'notes.md',
  folder: '',
  path: 'Projects/notes.md',
  state: 'live',
  versions: 3,
  bytes: 900,
  newest: '2026-09-17T09:00:00.000Z',
  zone: { id: 'z1', kind: 'volume', name: 'Projects' },
};

const VERSIONS = [
  { id: 'v1', size: 400, modifiedAt: '2026-09-17T09:00:00.000Z', author: { label: 'Alice' } },
  { id: 'v2', size: 500, modifiedAt: '2026-09-01T09:00:00.000Z', author: null },
];

const openPage = async () => {
  const wrapper = mount(SettingsFileVersions);
  await flushPromises();
  return wrapper;
};

const expand = async (wrapper) => {
  await wrapper.find('[data-test="versions-expand"]').trigger('click');
  await flushPromises();
};

beforeEach(() => {
  api.getVersionedFiles.mockReset().mockResolvedValue(page([NOTES]));
  api.getVersionedFile
    .mockReset()
    .mockResolvedValue({ file: { ...NOTES }, versions: VERSIONS, totalBytes: 900 });
  api.deleteVersionsOfFile.mockReset().mockResolvedValue({ deleted: 1, remaining: 2 });
});

describe('the list', () => {
  it('reads a page on arrival and shows what each history holds', async () => {
    const wrapper = await openPage();

    expect(api.getVersionedFiles).toHaveBeenCalledTimes(1);
    const row = wrapper.find('[data-test="versions-row"]');
    expect(row.text()).toContain('notes.md');
    expect(wrapper.find('[data-test="versions-count"]').text()).toBe('3');
  });

  it('says so when there is nothing, rather than showing an empty table', async () => {
    api.getVersionedFiles.mockResolvedValue(page([]));

    const wrapper = await openPage();

    expect(wrapper.find('[data-test="versions-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="versions-row"]').exists()).toBe(false);
  });

  it('starts again at the first page when a filter changes', async () => {
    api.getVersionedFiles.mockResolvedValue(
      page([NOTES, { ...NOTES, id: 'f2', name: 'b.md' }, { ...NOTES, id: 'f3', name: 'c.md' }], {
        total: 100,
      })
    );
    const wrapper = await openPage();
    await wrapper.find('[data-test="versions-next"]').trigger('click');
    await flushPromises();
    expect(api.getVersionedFiles.mock.calls.at(-1)[0].offset).toBe(25);

    // Paging through a filter's results and then changing the filter used to
    // ask for page two of a list that now has one page.
    await wrapper.find('[data-test="versions-sort"]').setValue('path');
    await flushPromises();

    expect(api.getVersionedFiles.mock.calls.at(-1)[0]).toMatchObject({ sort: 'path', offset: 0 });
  });

  it('shows the error the server gave rather than an empty page', async () => {
    api.getVersionedFiles.mockRejectedValue(new Error('the disk is on fire'));

    const wrapper = await openPage();

    expect(wrapper.find('[data-test="versions-error"]').text()).toContain('the disk is on fire');
  });
});

describe('one history', () => {
  it('reads its versions when the row is opened, and only then', async () => {
    const wrapper = await openPage();
    expect(api.getVersionedFile).not.toHaveBeenCalled();

    await expand(wrapper);

    expect(api.getVersionedFile).toHaveBeenCalledWith('f1');
    expect(wrapper.findAll('[data-test="versions-version"]')).toHaveLength(2);
  });

  it('does not read them again when the row is closed and opened', async () => {
    const wrapper = await openPage();
    await expand(wrapper);
    await expand(wrapper);
    await expand(wrapper);

    expect(api.getVersionedFile).toHaveBeenCalledTimes(1);
  });
});

describe('deleting', () => {
  it('asks before deleting a whole history, and does nothing until it is answered', async () => {
    const wrapper = await openPage();

    await wrapper.find('[data-test="versions-delete-all"]').trigger('click');

    expect(wrapper.find('[data-test="dialog"]').exists()).toBe(true);
    expect(api.deleteVersionsOfFile).not.toHaveBeenCalled();
  });

  it('deletes the whole history once it is confirmed', async () => {
    const wrapper = await openPage();
    await wrapper.find('[data-test="versions-delete-all"]').trigger('click');

    await wrapper.find('[data-test="versions-confirm"]').trigger('click');
    await flushPromises();

    expect(api.deleteVersionsOfFile).toHaveBeenCalledWith('f1', { all: true });
  });

  it('deletes only the versions that were ticked', async () => {
    const wrapper = await openPage();
    await expand(wrapper);

    await wrapper.findAll('input[type="checkbox"]')[1].trigger('change');
    await wrapper.find('[data-test="versions-delete-selected"]').trigger('click');
    await wrapper.find('[data-test="versions-confirm"]').trigger('click');
    await flushPromises();

    expect(api.deleteVersionsOfFile).toHaveBeenCalledWith('f1', { ids: ['v2'] });
  });

  it('offers nothing to delete until something is ticked', async () => {
    const wrapper = await openPage();
    await expand(wrapper);

    expect(
      wrapper.find('[data-test="versions-delete-selected"]').attributes('disabled')
    ).toBeDefined();
  });

  it('reads both the row and the versions again afterwards', async () => {
    const wrapper = await openPage();
    await expand(wrapper);
    api.getVersionedFiles.mockClear();
    api.getVersionedFile.mockClear();

    await wrapper.find('[data-test="versions-delete-all"]').trigger('click');
    await wrapper.find('[data-test="versions-confirm"]').trigger('click');
    await flushPromises();

    expect(api.getVersionedFiles).toHaveBeenCalledTimes(1);
    expect(api.getVersionedFile).toHaveBeenCalledTimes(1);
  });

  it('shows what went wrong when the deletion is refused', async () => {
    api.deleteVersionsOfFile.mockRejectedValue(new Error('the volume is not available'));
    const wrapper = await openPage();
    await wrapper.find('[data-test="versions-delete-all"]').trigger('click');

    await wrapper.find('[data-test="versions-confirm"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="versions-error"]').text()).toContain('not available');
  });
});
