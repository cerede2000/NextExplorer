import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

const browse = vi.fn();
const fetchRecentDestinations = vi.fn();
const fetchFavorites = vi.fn();

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  fetchRecentDestinations: (...args) => fetchRecentDestinations(...args),
  fetchFavorites: (...args) => fetchFavorites(...args),
  addFavorite: vi.fn(),
  updateFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
  removeFavorite: vi.fn(),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

import DestinationPickerDialog from './DestinationPickerDialog.vue';
import { useDestinationPicker } from '@/composables/useDestinationPicker';
import { useFavoritesStore } from '@/stores/favorites';

/**
 * Choosing where something goes.
 *
 * This dialog exists because dragging is switched off on touch devices, so it
 * has to stand on its own: offer the folders someone actually uses, and refuse
 * — before the transfer, not after — the destinations the server would reject
 * anyway. A picker that lets you choose a folder and then fails is worse than
 * one that never offered it.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { cancel: 'Cancel', close: 'Close', loadingEllipsis: 'Loading…' },
      storagePicker: { root: 'Storage', breadcrumb: 'Folder path' },
      destinationPicker: {
        moveTitle: 'Move to',
        copyTitle: 'Copy to',
        restoreTitle: 'Restore to',
        moveHere: 'Move here',
        copyHere: 'Copy here',
        restoreHere: 'Restore here',
        noFolders: 'No folders here',
        rootRejected: 'Pick a volume or folder first',
        itselfRejected: 'A folder cannot be moved into itself',
        descendantRejected: 'A folder cannot be moved into one of its own folders',
        alreadyThereRejected: 'Already here',
        versionCopyTitle: 'Restore a copy to',
        versionCopyHere: 'Restore a copy here',
        replaceTitle: 'Choose the file to replace',
        replaceHere: 'Replace this file',
        fileRequired: 'Pick a file',
        sameFileRejected: 'Pick a file other than this one',
        nothingHere: 'Nothing here',
      },
    },
  },
});

const folder = (name, path = '') => ({ name, path, kind: 'directory' });

const listing = (items, path = '') => ({ items, path });

// ModalDialog teleports to the body, so the dialog is inspected there rather
// than inside the wrapper.
let wrapper = null;
const mountDialog = () => {
  wrapper = mount(DestinationPickerDialog, {
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  return wrapper;
};

const buttons = () => Array.from(document.querySelectorAll('button'));
const bodyText = () => document.body.textContent || '';

/** The button that commits the choice. */
const confirmButton = () =>
  buttons().find((button) => /^(Move|Copy|Restore) here$/.test(button.textContent.trim()));

describe('DestinationPickerDialog', () => {
  let picker;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    document.body.innerHTML = '';
    fetchRecentDestinations.mockResolvedValue([]);
    fetchFavorites.mockResolvedValue([]);
    browse.mockResolvedValue(listing([]));

    picker = useDestinationPicker();
    picker.isOpen.value = false;
    picker.items.value = [];
    picker.mode.value = 'move';
    picker.initialPath.value = '';
  });

  it('hands back the folder that was open when confirmed', async () => {
    browse.mockResolvedValue(listing([folder('Archive', 'Docs')], 'Docs'));

    mountDialog();
    const chosen = picker.pick({ mode: 'move', items: [{ name: 'a.txt', path: 'Inbox' }] });
    await flushPromises();

    confirmButton().click();
    await flushPromises();

    await expect(chosen).resolves.toBe('Docs');
  });

  it('reports nothing chosen when the dialog is dismissed', async () => {
    // Callers must be able to tell "cancelled" from "chose the root", which the
    // server would refuse anyway.
    mountDialog();
    const chosen = picker.pick({ items: [{ name: 'a.txt', path: 'Docs' }] });
    await flushPromises();

    buttons()
      .find((button) => button.textContent.trim() === 'Cancel')
      .click();
    await flushPromises();

    await expect(chosen).resolves.toBeNull();
  });

  it('refuses the root, which has no volume to write to', async () => {
    browse.mockResolvedValue(listing([folder('Docs')], ''));

    mountDialog();
    picker.pick({ items: [{ name: 'a.txt', path: 'Docs' }] });
    await flushPromises();

    expect(bodyText()).toContain('Pick a volume or folder first');
    expect(confirmButton().disabled).toBe(true);
  });

  it('refuses a folder being moved into itself', async () => {
    browse.mockResolvedValue(listing([], 'Docs/Reports'));

    mountDialog();
    picker.pick({ items: [{ name: 'Reports', path: 'Docs', kind: 'directory' }] });
    await flushPromises();

    expect(bodyText()).toContain('A folder cannot be moved into itself');
    expect(confirmButton().disabled).toBe(true);
  });

  it('refuses a folder being moved inside one of its own folders', async () => {
    // The deeper case, which is the one people actually hit by browsing into it.
    browse.mockResolvedValue(listing([], 'Docs/Reports/2026'));

    mountDialog();
    picker.pick({ items: [{ name: 'Reports', path: 'Docs', kind: 'directory' }] });
    await flushPromises();

    expect(bodyText()).toContain('A folder cannot be moved into one of its own folders');
    expect(confirmButton().disabled).toBe(true);
  });

  it('refuses moving something back where it already is', async () => {
    browse.mockResolvedValue(listing([], 'Docs'));

    mountDialog();
    picker.pick({ mode: 'move', items: [{ name: 'a.txt', path: 'Docs' }] });
    await flushPromises();

    expect(bodyText()).toContain('Already here');
  });

  it('allows copying into the folder something is already in', async () => {
    // Copying beside the original is a real thing to want — it produces the
    // usual duplicate — so the move-only check must not apply here.
    browse.mockResolvedValue(listing([], 'Docs'));

    mountDialog();
    picker.pick({ mode: 'copy', items: [{ name: 'a.txt', path: 'Docs' }] });
    await flushPromises();

    expect(bodyText()).not.toContain('Already here');
    expect(confirmButton().disabled).toBe(false);
  });

  it('offers recent destinations and favorites, without repeating one', async () => {
    fetchRecentDestinations.mockResolvedValue(['Docs/Reports', 'Media']);
    fetchFavorites.mockResolvedValue([
      { id: '1', path: 'Media' },
      { id: '2', path: 'Backups' },
    ]);
    useFavoritesStore();

    mountDialog();
    picker.pick({ items: [{ name: 'a.txt', path: 'Inbox' }] });
    await flushPromises();

    const shortcuts = buttons().map((button) => button.textContent);
    expect(shortcuts.filter((text) => text.includes('Media'))).toHaveLength(1);
    expect(shortcuts.some((text) => text.includes('Docs/Reports'))).toBe(true);
    expect(shortcuts.some((text) => text.includes('Backups'))).toBe(true);
  });

  it('leaves out a shortcut that would be an invalid destination', async () => {
    // A favorite pointing at the folder being moved is still a favorite; it is
    // just not somewhere this transfer can go.
    fetchRecentDestinations.mockResolvedValue(['Docs/Reports']);

    mountDialog();
    picker.pick({ items: [{ name: 'Reports', path: 'Docs', kind: 'directory' }] });
    await flushPromises();

    expect(bodyText()).not.toContain('Docs/Reports');
  });

  it('still browses when recent destinations cannot be loaded', async () => {
    fetchRecentDestinations.mockRejectedValue(new Error('nope'));
    browse.mockResolvedValue(listing([folder('Archive', 'Docs')], 'Docs'));

    mountDialog();
    picker.pick({ items: [{ name: 'a.txt', path: 'Inbox' }] });
    await flushPromises();

    expect(bodyText()).toContain('Archive');
    expect(confirmButton().disabled).toBe(false);
  });

  /**
   * Out of the trash, nothing is taken from a folder: the only destination to
   * refuse is the root, and the dialog says what will happen in its own words.
   */
  it('asks where to restore, in those words, and hands back the folder chosen', async () => {
    browse.mockResolvedValue(listing([folder('Archive', 'Docs')], 'Docs'));

    mountDialog();
    const chosen = picker.pick({ mode: 'restore' });
    await flushPromises();

    expect(bodyText()).toContain('Restore to');
    expect(confirmButton().textContent.trim()).toBe('Restore here');
    confirmButton().click();
    await flushPromises();

    await expect(chosen).resolves.toBe('Docs');
  });

  /**
   * An earlier version taken out as a copy goes into a folder, and may go beside
   * the file it came from: that is the usual place for a copy.
   */
  it('asks where to put a copy of a version, beside its file included', async () => {
    browse.mockResolvedValue(listing([], 'Docs'));

    mountDialog();
    const chosen = picker.pick({
      mode: 'version-copy',
      items: [{ name: 'notes.md', path: 'Docs', kind: 'file' }],
      from: 'Docs',
    });
    await flushPromises();

    const confirmCopy = buttons().find((b) => b.textContent.trim() === 'Restore a copy here');
    expect(bodyText()).toContain('Restore a copy to');
    expect(bodyText()).not.toContain('Already here');
    confirmCopy.click();
    await flushPromises();

    await expect(chosen).resolves.toBe('Docs');
  });

  describe('choosing a file rather than a folder', () => {
    const files = () =>
      Array.from(document.querySelectorAll('[data-test="destination-picker-file"]'));
    const replaceButton = () => buttons().find((b) => b.textContent.trim() === 'Replace this file');
    const source = [{ name: 'notes.md', path: 'Docs', kind: 'file' }];

    it('lists the files beside the folders, and asks for one before anything is confirmed', async () => {
      browse.mockResolvedValue(
        listing([folder('Old', 'Docs'), { name: 'draft.md', path: 'Docs', kind: 'md' }], 'Docs')
      );

      mountDialog();
      picker.pick({ mode: 'file', items: source, from: 'Docs' });
      await flushPromises();

      expect(bodyText()).toContain('Choose the file to replace');
      expect(bodyText()).toContain('Old');
      expect(files().map((button) => button.textContent.trim())).toEqual(['draft.md']);
      expect(bodyText()).toContain('Pick a file');
      expect(replaceButton().disabled).toBe(true);
    });

    it('hands back the path of the file chosen', async () => {
      browse.mockResolvedValue(listing([{ name: 'draft.md', path: 'Docs', kind: 'md' }], 'Docs'));

      mountDialog();
      const chosen = picker.pick({ mode: 'file', items: source, from: 'Docs' });
      await flushPromises();

      files()[0].click();
      await flushPromises();
      expect(replaceButton().disabled).toBe(false);
      replaceButton().click();
      await flushPromises();

      await expect(chosen).resolves.toBe('Docs/draft.md');
    });

    it('refuses the file the version belongs to, which a restore already covers', async () => {
      browse.mockResolvedValue(listing([{ name: 'notes.md', path: 'Docs', kind: 'md' }], 'Docs'));

      mountDialog();
      picker.pick({ mode: 'file', items: source, from: 'Docs' });
      await flushPromises();

      files()[0].click();
      await flushPromises();

      expect(bodyText()).toContain('Pick a file other than this one');
      expect(replaceButton().disabled).toBe(true);
    });

    it('forgets the file chosen once another folder is opened', async () => {
      browse
        .mockResolvedValueOnce(
          listing([folder('Old', 'Docs'), { name: 'draft.md', path: 'Docs', kind: 'md' }], 'Docs')
        )
        .mockResolvedValueOnce(listing([], 'Docs/Old'));

      mountDialog();
      picker.pick({ mode: 'file', items: source, from: 'Docs' });
      await flushPromises();
      files()[0].click();
      await flushPromises();

      buttons()
        .find((b) => b.textContent.trim() === 'Old')
        .click();
      await flushPromises();

      expect(bodyText()).toContain('Nothing here');
      expect(replaceButton().disabled).toBe(true);
    });
  });
});
