import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

/**
 * Creating, renaming, and the clipboard.
 *
 * Forty percent of the store's functions had no test, and this is the half a
 * person touches most: making a folder, renaming it, cutting it somewhere else.
 * The behaviours here are small and each one is a thing somebody notices when
 * it stops — a new folder that does not open its rename box leaves you hunting
 * for it in a sorted list, and a cut that does not clear the copy leaves two
 * pending operations where the next paste picks the wrong one.
 */

const browse = vi.fn();
const createFolderApi = vi.fn();
const createFileApi = vi.fn();
const createOfficeDocumentApi = vi.fn();
const renameItem = vi.fn();
const scheduleVolumeRefresh = vi.fn();
const scheduleFolderRefresh = vi.fn();

vi.mock('@/api', () => ({
  browse: (...args) => browse(...args),
  browseShare: vi.fn(),
  normalizePath: (path = '') => String(path).replace(/^\/+|\/+$/g, ''),
  deleteItemsStream: vi.fn(),
  copyItems: vi.fn(),
  moveItems: vi.fn(),
  createFolder: (...args) => createFolderApi(...args),
  createFile: (...args) => createFileApi(...args),
  createOfficeDocument: (...args) => createOfficeDocumentApi(...args),
  renameItem: (...args) => renameItem(...args),
  fetchThumbnail: vi.fn(),
  extractZip: vi.fn(),
  compressToZip: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    sortBy: { by: 'name', order: 'asc' },
    restoreFolderPreferences: vi.fn(),
  }),
}));
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({ thumbnailsEnabledForSession: false }),
}));
vi.mock('@/stores/favorites', () => ({ useFavoritesStore: () => ({ loadFavorites: vi.fn() }) }));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: scheduleVolumeRefresh }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: scheduleFolderRefresh }),
}));
vi.mock('@vueuse/core', () => ({ useStorage: (_key, initial) => ref(initial) }));

import { useFileStore } from './fileStore';

const item = (name, extra = {}) => ({ name, path: 'Docs', kind: 'txt', ...extra });

/** A store sitting in Docs with two files listed. */
const storeInDocs = async (listing = [item('a.txt'), item('b.txt')]) => {
  const store = useFileStore();
  browse.mockResolvedValue({ items: listing, path: 'Docs' });
  await store.fetchPathItems('Docs');
  return store;
};

beforeEach(() => {
  setActivePinia(createPinia());
  [
    browse,
    createFolderApi,
    createFileApi,
    createOfficeDocumentApi,
    renameItem,
    scheduleVolumeRefresh,
    scheduleFolderRefresh,
  ].forEach((m) => m.mockReset());
  browse.mockResolvedValue({ items: [], path: '' });
});

describe('the clipboard', () => {
  it('copies the selection, detached from it', async () => {
    const store = await storeInDocs();
    const first = store.currentPathItems ? store.currentPathItems[0] : item('a.txt');
    store.selectedItems = [first];

    store.copy();

    expect(store.copiedItems).toHaveLength(1);
    expect(store.copiedItems[0]).not.toBe(first);
    expect(store.copiedItems[0].name).toBe(first.name);
  });

  /**
   * The two are exclusive. Leaving the other populated means the next paste has
   * two candidate operations and picks by whichever branch runs first.
   */
  it('cutting clears a pending copy, and the other way round', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];

    store.copy();
    expect(store.copiedItems).toHaveLength(1);

    store.cut();
    expect(store.copiedItems).toHaveLength(0);
    expect(store.cutItems).toHaveLength(1);

    store.copy();
    expect(store.cutItems).toHaveLength(0);
    expect(store.copiedItems).toHaveLength(1);
  });

  it('does nothing at all with an empty selection', async () => {
    const store = await storeInDocs();
    store.selectedItems = [];

    store.copy();
    store.cut();

    expect(store.copiedItems).toHaveLength(0);
    expect(store.cutItems).toHaveLength(0);
  });

  it('keeps a previous clipboard when asked to copy nothing', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];
    store.copy();

    store.selectedItems = [];
    store.cut();

    expect(store.copiedItems).toHaveLength(1);
  });
});

describe('creating a folder', () => {
  it('creates it in the folder being looked at', async () => {
    const store = await storeInDocs();
    createFolderApi.mockResolvedValue({ item: { name: 'New folder' } });

    await store.createFolder('New folder');

    expect(createFolderApi).toHaveBeenCalledWith('Docs', 'New folder');
  });

  /**
   * The rename box is how the name gets typed. Without it a new folder lands
   * somewhere in a sorted list called "New folder" and has to be found again.
   */
  it('selects it and opens the rename box, flagged as new', async () => {
    const store = useFileStore();
    createFolderApi.mockResolvedValue({ item: { name: 'New folder' } });
    browse.mockResolvedValue({
      items: [item('New folder', { kind: 'directory' })],
      path: 'Docs',
    });
    await store.fetchPathItems('Docs');

    await store.createFolder('New folder');

    expect(store.selectedItems.map((i) => i.name)).toEqual(['New folder']);
    expect(store.renameState).toMatchObject({ originalName: 'New folder', isNew: true });
  });

  it('refreshes the listing so the new folder is actually there', async () => {
    const store = await storeInDocs();
    createFolderApi.mockResolvedValue({ item: { name: 'New folder' } });
    browse.mockClear();

    await store.createFolder('New folder');

    expect(browse).toHaveBeenCalled();
  });

  it('asks the usage and folder-size stores to catch up', async () => {
    const store = await storeInDocs();
    createFolderApi.mockResolvedValue({ item: { name: 'New folder' } });

    await store.createFolder('New folder');

    expect(scheduleVolumeRefresh).toHaveBeenCalled();
    expect(scheduleFolderRefresh).toHaveBeenCalled();
  });

  /** A server that answers without naming the item leaves nothing to rename. */
  it('does not open a rename box it has no target for', async () => {
    const store = await storeInDocs();
    createFolderApi.mockResolvedValue({});

    await store.createFolder('New folder');

    expect(store.renameState).toBeNull();
  });
});

describe('creating a document', () => {
  /**
   * Deliberately unlike createFile: the name was settled before the document
   * existed and the caller opens an editor over it straight away, so a rename
   * box would sit behind an overlay where nobody can see it.
   */
  it('selects it without opening a rename box', async () => {
    const store = useFileStore();
    createOfficeDocumentApi.mockResolvedValue({ item: { name: 'Report.docx' } });
    browse.mockResolvedValue({ items: [item('Report.docx', { kind: 'docx' })], path: 'Docs' });
    await store.fetchPathItems('Docs');

    const created = await store.createOfficeDocument({ format: 'docx', name: 'Report' });

    expect(store.renameState).toBeNull();
    expect(store.selectedItems.map((i) => i.name)).toEqual(['Report.docx']);
    expect(created?.name).toBe('Report.docx');
  });

  it('falls back to what the server reported when the listing has not caught up', async () => {
    const store = await storeInDocs();
    createOfficeDocumentApi.mockResolvedValue({ item: { name: 'Late.docx' } });

    const created = await store.createOfficeDocument({ format: 'docx', name: 'Late' });

    expect(created).toMatchObject({ name: 'Late.docx' });
  });
});

describe('renaming', () => {
  const startRename = async (draft, { original = 'a.txt' } = {}) => {
    const store = useFileStore();
    browse.mockResolvedValue({ items: [item(original)], path: 'Docs' });
    await store.fetchPathItems('Docs');
    store.beginRename(item(original));
    store.setRenameDraft(draft);
    return store;
  };

  it('sends the old and the new name for the folder it is in', async () => {
    const store = await startRename('b.txt');
    renameItem.mockResolvedValue({ item: { name: 'b.txt' } });

    await store.applyRename();

    expect(renameItem).toHaveBeenCalledWith('Docs', 'a.txt', 'b.txt');
  });

  it.each([
    ['an empty name', ''],
    ['only spaces', '   '],
  ])('sends nothing for %s, and closes the box', async (_label, draft) => {
    const store = await startRename(draft);

    await store.applyRename();

    expect(renameItem).not.toHaveBeenCalled();
    expect(store.renameState).toBeNull();
  });

  it('sends nothing when the name did not change', async () => {
    const store = await startRename('a.txt');

    await store.applyRename();

    expect(renameItem).not.toHaveBeenCalled();
    expect(store.renameState).toBeNull();
  });

  /**
   * The server may not give the name that was asked for — a collision, a
   * character it strips. Selecting the requested name would select nothing.
   */
  it('follows the name the server settled on', async () => {
    const store = useFileStore();
    browse.mockResolvedValueOnce({ items: [item('a.txt')], path: 'Docs' });
    await store.fetchPathItems('Docs');
    store.beginRename(item('a.txt'));
    store.setRenameDraft('b.txt');
    renameItem.mockResolvedValue({ item: { name: 'b (2).txt' } });
    browse.mockResolvedValue({ items: [item('b (2).txt')], path: 'Docs' });

    await store.applyRename();

    expect(store.selectedItems.map((i) => i.name)).toEqual(['b (2).txt']);
  });

  it('closes the box before the listing comes back, not after', async () => {
    const store = await startRename('b.txt');
    renameItem.mockResolvedValue({ item: { name: 'b.txt' } });

    await store.applyRename();

    expect(store.renameState).toBeNull();
  });

  it('does nothing when no rename is in progress', async () => {
    const store = await storeInDocs();

    await store.applyRename();

    expect(renameItem).not.toHaveBeenCalled();
  });

  it('cancelling forgets the draft entirely', async () => {
    const store = await startRename('b.txt');

    store.cancelRename();

    expect(store.renameState).toBeNull();
  });

  it('knows which row is the one being renamed', async () => {
    const store = await startRename('b.txt');

    expect(store.isItemBeingRenamed(item('a.txt'))).toBe(true);
    expect(store.isItemBeingRenamed(item('other.txt'))).toBe(false);
  });

  it('ignores a request to rename something with no name', async () => {
    const store = await storeInDocs();

    store.beginRename({ path: 'Docs' });
    store.beginRename(null);

    expect(store.renameState).toBeNull();
  });

  it('starts the draft as the current name, so Enter alone changes nothing', async () => {
    const store = await storeInDocs();

    store.beginRename(item('a.txt'));

    expect(store.renameState.draft).toBe('a.txt');
    expect(store.renameState.originalName).toBe('a.txt');
  });
});
