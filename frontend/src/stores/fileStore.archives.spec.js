import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

/**
 * Extracting an archive, and zipping a selection.
 *
 * Both are long operations that can be cancelled, both report progress, and one
 * of them can stop halfway to ask a question. That last one is the reason this
 * file exists: a password-protected archive comes back as a *return value*
 * rather than a thrown error — `{ requiresPassword: true }` — so the dialog can
 * ask and try again. Turn that back into a throw and the archive simply fails,
 * with the reason on the console and nothing on screen.
 *
 * A cancellation is not a failure either. The operation panel closes, the
 * listing is refreshed because a partial extraction may have left files behind,
 * and nobody is shown an error for something they chose to stop.
 */

const browse = vi.fn();
const extractZipApi = vi.fn();
const compressToZipApi = vi.fn();
const startOperation = vi.fn(() => 'op-1');
const updateOperation = vi.fn();
const finishOperation = vi.fn();
const scheduleVolumeRefresh = vi.fn();
const scheduleFolderRefresh = vi.fn();

vi.mock('@/api', () => ({
  browse: (...a) => browse(...a),
  browseShare: vi.fn(),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
  deleteItemsStream: vi.fn(),
  copyItems: vi.fn(),
  moveItems: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  createOfficeDocument: vi.fn(),
  renameItem: vi.fn(),
  fetchThumbnail: vi.fn(),
  extractZip: (...a) => extractZipApi(...a),
  compressToZip: (...a) => compressToZipApi(...a),
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
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startOperation: (...a) => startOperation(...a),
    updateOperation: (...a) => updateOperation(...a),
    finishOperation: (...a) => finishOperation(...a),
  }),
}));
vi.mock('@vueuse/core', () => ({ useStorage: (_k, initial) => ref(initial) }));

import { useFileStore } from './fileStore';

const item = (name, extra = {}) => ({ name, path: 'Docs', kind: 'zip', ...extra });

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

const withCode = (code) => Object.assign(new Error(code), { code });

const storeInDocs = async (listing = [item('backup.zip')]) => {
  const store = useFileStore();
  browse.mockResolvedValue({ items: listing, path: 'Docs' });
  await store.fetchPathItems('Docs');
  return store;
};

beforeEach(() => {
  setActivePinia(createPinia());
  [
    browse,
    extractZipApi,
    compressToZipApi,
    startOperation,
    updateOperation,
    finishOperation,
    scheduleVolumeRefresh,
    scheduleFolderRefresh,
  ].forEach((m) => m.mockReset());
  browse.mockResolvedValue({ items: [], path: '' });
  startOperation.mockReturnValue('op-1');
  extractZipApi.mockResolvedValue({ item: { name: 'backup' } });
  compressToZipApi.mockResolvedValue({ item: { name: 'archive.zip' } });
});

describe('extracting', () => {
  it('sends the archive path and shows a cancellable operation', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('/Docs/backup.zip');

    expect(extractZipApi).toHaveBeenCalledWith('Docs/backup.zip', expect.anything());
    expect(startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extract', name: 'backup.zip', cancellable: true })
    );
  });

  it('does nothing at all without a path', async () => {
    const store = await storeInDocs();

    expect(await store.extractZipArchive('')).toBeNull();
    expect(extractZipApi).not.toHaveBeenCalled();
  });

  it('reports progress into the operation panel', async () => {
    const store = await storeInDocs();
    extractZipApi.mockImplementation(async (_path, { onEvent }) => {
      onEvent({ type: 'progress', percent: 42 });
      return { item: { name: 'backup' } };
    });

    await store.extractZipArchive('Docs/backup.zip');

    expect(updateOperation).toHaveBeenCalledWith('op-1', { percent: 42 });
  });

  it('ignores a progress event with no usable percentage', async () => {
    const store = await storeInDocs();
    extractZipApi.mockImplementation(async (_path, { onEvent }) => {
      onEvent({ type: 'progress' });
      onEvent({ type: 'progress', percent: 'nearly' });
      onEvent({ type: 'start' });
      return { item: { name: 'backup' } };
    });

    await store.extractZipArchive('Docs/backup.zip');

    expect(updateOperation).not.toHaveBeenCalled();
  });

  it('closes the operation whatever happens', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(new Error('disk full'));

    await expect(store.extractZipArchive('Docs/backup.zip')).rejects.toThrow('disk full');
    expect(finishOperation).toHaveBeenCalledWith('op-1');
  });

  it('refreshes the folder the archive was in, and the size stores', async () => {
    const store = await storeInDocs();
    browse.mockClear();

    await store.extractZipArchive('Docs/backup.zip');

    expect(browse).toHaveBeenCalled();
    expect(scheduleVolumeRefresh).toHaveBeenCalled();
    expect(scheduleFolderRefresh).toHaveBeenCalled();
  });

  it('selects what came out of it', async () => {
    const store = useFileStore();
    browse.mockResolvedValue({
      items: [item('backup.zip'), item('backup', { kind: 'directory' })],
      path: 'Docs',
    });
    await store.fetchPathItems('Docs');

    await store.extractZipArchive('Docs/backup.zip');

    expect(store.selectedItems.map((i) => i.name)).toEqual(['backup']);
  });

  it('passes the destination and the password through', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('Docs/backup.zip', {
      destination: 'current',
      password: 'secret',
    });

    expect(extractZipApi).toHaveBeenCalledWith(
      'Docs/backup.zip',
      expect.objectContaining({ destination: 'current', password: 'secret' })
    );
  });
});

describe('an archive that wants a password', () => {
  /**
   * Returned rather than thrown, so the dialog can ask and call back with one.
   * A throw here loses the archive: the reason goes to the console and the
   * person sees a failure with no way to answer it.
   */
  it('comes back as an answer, not a failure', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(withCode('ARCHIVE_PASSWORD_REQUIRED'));

    const result = await store.extractZipArchive('Docs/backup.zip');

    expect(result).toEqual({
      requiresPassword: true,
      invalidPassword: false,
      path: 'Docs/backup.zip',
      destination: undefined,
    });
  });

  it('distinguishes a wrong password from a missing one', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(withCode('ARCHIVE_INVALID_PASSWORD'));

    const result = await store.extractZipArchive('Docs/backup.zip');

    expect(result).toMatchObject({ requiresPassword: true, invalidPassword: true });
  });

  /** So the retry lands in the same place as the first attempt. */
  it('remembers the destination so the retry goes to the same place', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(withCode('ARCHIVE_PASSWORD_REQUIRED'));

    const result = await store.extractZipArchive('Docs/backup.zip', { destination: 'current' });

    expect(result.destination).toBe('current');
  });

  /** Those two codes are silenced so no toast appears behind the dialog. */
  it('asks the api not to report those two through the global handler', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('Docs/backup.zip');

    expect(extractZipApi.mock.calls[0][1].suppressErrorCodes).toEqual([
      'ARCHIVE_PASSWORD_REQUIRED',
      'ARCHIVE_INVALID_PASSWORD',
    ]);
  });

  it('still closes the operation panel', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(withCode('ARCHIVE_PASSWORD_REQUIRED'));

    await store.extractZipArchive('Docs/backup.zip');

    expect(finishOperation).toHaveBeenCalledWith('op-1');
  });
});

describe('an extraction somebody stopped', () => {
  /**
   * Cancelling is not failing. The listing is refreshed because a partial
   * extraction may have left files behind, and nobody is shown an error.
   */
  it('answers with nothing rather than raising', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(abortError());

    expect(await store.extractZipArchive('Docs/backup.zip')).toBeNull();
  });

  it('refreshes afterwards, since a half-extraction leaves files behind', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(abortError());
    browse.mockClear();

    await store.extractZipArchive('Docs/backup.zip');

    expect(browse).toHaveBeenCalled();
  });

  it('hands the operation panel a way to stop it', async () => {
    const store = await storeInDocs();
    let signal;
    extractZipApi.mockImplementation(async (_p, options) => {
      signal = options.signal;
      return { item: { name: 'backup' } };
    });

    await store.extractZipArchive('Docs/backup.zip');
    const { cancel } = startOperation.mock.calls[0][0];
    cancel();

    expect(signal.aborted).toBe(true);
  });
});

describe('zipping a selection', () => {
  it('does nothing when nothing is selected', async () => {
    const store = await storeInDocs();
    store.selectedItems = [];

    expect(await store.compressSelectionToZip()).toBeNull();
    expect(compressToZipApi).not.toHaveBeenCalled();
  });

  it('shows an operation counting the selected items', async () => {
    const store = await storeInDocs([item('a.txt'), item('b.txt')]);
    store.selectedItems = [item('a.txt'), item('b.txt')];

    await store.compressSelectionToZip('archive');

    expect(startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'compress', itemCount: 2 })
    );
  });

  it('trims the name, and sends none when it is only spaces', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];

    await store.compressSelectionToZip('  archive  ');
    expect(startOperation.mock.calls[0][0].name).toBe('archive');

    startOperation.mockClear();
    // The first run refreshes the listing and moves the selection with it, so
    // the second needs one of its own or it returns before starting anything.
    store.selectedItems = [item('a.txt')];
    await store.compressSelectionToZip('   ');
    expect(startOperation.mock.calls[0][0].name).toBe('');
  });

  it('closes the operation when it fails', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];
    compressToZipApi.mockRejectedValue(new Error('no space'));

    await expect(store.compressSelectionToZip('a')).rejects.toThrow('no space');
    expect(finishOperation).toHaveBeenCalled();
  });
});
