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
/**
 * The panel an operation registers itself with.
 *
 * `startServerOperation` is where a bar, the operation's own figures and a
 * cancel that asks the server all come from — one implementation for every long
 * operation — so this spec asks that these gestures go through it, and the store
 * spec holds what it does.
 */
const onOperationEvent = vi.fn();
const onOperationTask = vi.fn();
const finishOperation = vi.fn();
const startServerOperation = vi.fn(() => ({
  id: 'op-1',
  onEvent: onOperationEvent,
  onTask: onOperationTask,
  finish: finishOperation,
}));
const updateOperation = vi.fn();
const scheduleVolumeRefresh = vi.fn();
const scheduleFolderRefresh = vi.fn();
const addNotification = vi.fn();

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
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: (...a) => addNotification(...a) }),
}));
vi.mock('@/stores/volumeUsage', () => ({
  useVolumeUsageStore: () => ({ scheduleRefresh: scheduleVolumeRefresh }),
}));
vi.mock('@/stores/folderSize', () => ({
  useFolderSizeStore: () => ({ scheduleRefresh: scheduleFolderRefresh }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startServerOperation: (...a) => startServerOperation(...a),
    updateOperation: (...a) => updateOperation(...a),
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
    startServerOperation,
    onOperationEvent,
    onOperationTask,
    updateOperation,
    finishOperation,
    scheduleVolumeRefresh,
    scheduleFolderRefresh,
    addNotification,
  ].forEach((m) => m.mockReset());
  browse.mockResolvedValue({ items: [], path: '' });
  startServerOperation.mockReturnValue({
    id: 'op-1',
    onEvent: onOperationEvent,
    onTask: onOperationTask,
    finish: finishOperation,
  });
  extractZipApi.mockResolvedValue({ item: { name: 'backup' } });
  compressToZipApi.mockResolvedValue({ item: { name: 'archive.zip' } });
});

describe('extracting', () => {
  it('sends the archive path and registers the operation, named for the archive', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('/Docs/backup.zip');

    expect(extractZipApi).toHaveBeenCalledWith('Docs/backup.zip', expect.anything());
    expect(startServerOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extract', name: 'backup.zip' })
    );
  });

  it('does nothing at all without a path', async () => {
    const store = await storeInDocs();

    expect(await store.extractZipArchive('')).toBeNull();
    expect(extractZipApi).not.toHaveBeenCalled();
  });

  // Through the registration, and nothing else: what the bar is drawn from is
  // the operation's own figures, read in one place.
  it('watches it and names it through that registration', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('Docs/backup.zip');

    expect(extractZipApi).toHaveBeenCalledWith(
      'Docs/backup.zip',
      expect.objectContaining({ onEvent: onOperationEvent, onTask: onOperationTask })
    );
  });

  it('closes the operation whatever happens', async () => {
    const store = await storeInDocs();
    extractZipApi.mockRejectedValue(new Error('disk full'));

    await expect(store.extractZipArchive('Docs/backup.zip')).rejects.toThrow('disk full');
    expect(finishOperation).toHaveBeenCalled();
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

    expect(finishOperation).toHaveBeenCalled();
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

  /**
   * And no connection of its own to hang up on.
   *
   * The extraction runs in the server, so an abort would stop the watching and
   * nothing else — a cancel button that silently does nothing. Stopping one is
   * the registration's business, and it asks the server.
   */
  it('hangs up on nothing to stop it', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('Docs/backup.zip');

    expect(extractZipApi.mock.calls[0][1].signal).toBeUndefined();
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

    expect(startServerOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'compress', itemCount: 2 })
    );
  });

  it('trims the name, and sends none when it is only spaces', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];

    await store.compressSelectionToZip('  archive  ');
    expect(startServerOperation.mock.calls[0][0].name).toBe('archive');

    startServerOperation.mockClear();
    // The first run refreshes the listing and moves the selection with it, so
    // the second needs one of its own or it returns before starting anything.
    store.selectedItems = [item('a.txt')];
    await store.compressSelectionToZip('   ');
    expect(startServerOperation.mock.calls[0][0].name).toBe('');
  });

  it('closes the operation when it fails', async () => {
    const store = await storeInDocs();
    store.selectedItems = [item('a.txt')];
    compressToZipApi.mockRejectedValue(new Error('no space'));

    await expect(store.compressSelectionToZip('a')).rejects.toThrow('no space');
    expect(finishOperation).toHaveBeenCalled();
  });
});

/**
 * An archive operation that could not read everything it was given.
 *
 * The server skips an entry whose name does not decode as UTF-8 rather than
 * failing the whole extraction, or the whole zip, over it. The folder is then
 * short of it and the archive is short of it, and the only thing that says so
 * is the count the answer carries — which is worth nothing until somebody says
 * it out loud.
 */
describe('what an archive operation says about the entries it could not read', () => {
  it('says how many an extraction left out', async () => {
    const store = await storeInDocs();
    extractZipApi.mockResolvedValue({ item: { name: 'backup' }, unreadable: 2 });

    await store.extractZipArchive('Docs/backup.zip');

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({ type: 'warning' });
  });

  it('says how many a zip left out', async () => {
    const store = await storeInDocs([item('Work', { kind: 'directory' })]);
    store.selectedItems = [item('Work', { kind: 'directory' })];
    compressToZipApi.mockResolvedValue({ item: { name: 'archive.zip' }, unreadable: 1 });

    await store.compressSelectionToZip('archive.zip');

    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('says nothing when everything was read', async () => {
    const store = await storeInDocs();

    await store.extractZipArchive('Docs/backup.zip');

    expect(addNotification).not.toHaveBeenCalled();
  });
});
