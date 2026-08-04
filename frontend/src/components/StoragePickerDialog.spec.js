import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

const browse = vi.fn();
vi.mock('@/api', () => ({ browse: (...args) => browse(...args) }));

import StoragePickerDialog from './StoragePickerDialog.vue';

/**
 * The picker exists so the editor can be handed a file from the user's own
 * storage. Two things about it are load-bearing: it must not offer a file the
 * caller cannot use, and folders must stay reachable so a file one level down
 * can still be picked.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { close: 'Close', cancel: 'Cancel', loadingEllipsis: 'Loading…' },
      storagePicker: { root: 'Storage', empty: 'Nothing here to pick', breadcrumb: 'Folder path' },
    },
  },
});

const listing = (items, path = '') => ({ items, path });

const mountPicker = (props = {}) =>
  mount(StoragePickerDialog, {
    props: { modelValue: true, extensions: ['png', 'jpg'], ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });

const optionLabels = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent.trim());

beforeEach(() => {
  browse.mockReset();
  document.body.innerHTML = '';
});

describe('StoragePickerDialog', () => {
  it('shows folders and only the file kinds the caller asked for', async () => {
    browse.mockResolvedValue(
      listing([
        { name: 'pictures', kind: 'directory', path: '' },
        { name: 'logo.png', kind: 'png', path: '' },
        { name: 'notes.docx', kind: 'docx', path: '' },
      ])
    );

    const wrapper = mountPicker();
    await flushPromises();

    // The document is hidden, not disabled: picking a file the editor cannot
    // read is a failure that only surfaces after the choice was made.
    expect(optionLabels()).toEqual(['pictures', 'logo.png']);

    wrapper.unmount();
  });

  it('opens on the folder it was pointed at', async () => {
    browse.mockResolvedValue(listing([], 'projects/2026'));

    const wrapper = mountPicker({ initialPath: 'projects/2026' });
    await flushPromises();

    expect(browse).toHaveBeenCalledWith('projects/2026');

    wrapper.unmount();
  });

  it('walks into a folder instead of selecting it', async () => {
    browse.mockResolvedValueOnce(listing([{ name: 'pictures', kind: 'directory', path: '' }]));
    browse.mockResolvedValueOnce(listing([{ name: 'shot.png', kind: 'png', path: 'pictures' }]));

    const wrapper = mountPicker();
    await flushPromises();

    document.querySelector('[role="option"]').click();
    await flushPromises();

    expect(browse).toHaveBeenLastCalledWith('pictures');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(optionLabels()).toEqual(['shot.png']);

    wrapper.unmount();
  });

  it('reports the full path of the picked file and closes', async () => {
    browse.mockResolvedValue(listing([{ name: 'shot.png', kind: 'png', path: 'pictures' }]));

    const wrapper = mountPicker();
    await flushPromises();

    document.querySelector('[role="option"]').click();
    await flushPromises();

    expect(wrapper.emitted('select')[0]).toEqual(['pictures/shot.png']);
    expect(wrapper.emitted('update:modelValue')[0]).toEqual([false]);

    wrapper.unmount();
  });

  it('says so when the folder holds nothing usable', async () => {
    browse.mockResolvedValue(listing([{ name: 'notes.docx', kind: 'docx', path: '' }]));

    const wrapper = mountPicker();
    await flushPromises();

    expect(document.body.textContent).toContain('Nothing here to pick');

    wrapper.unmount();
  });
});
