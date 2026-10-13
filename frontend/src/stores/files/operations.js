import {
  normalizePath,
  deleteItemsStream,
  createFile as createFileApi,
  createOfficeDocument as createOfficeDocumentApi,
  createFolder as createFolderApi,
  extractZip as extractZipApi,
  compressToZip as compressToZipApi,
} from '@/api';
import { isAbortError, itemKey, serializeItems } from './items';

/**
 * Deleting, making, and the two archive operations: what changes a folder's
 * contents from here, each followed by a fresh listing.
 *
 * @param {object} options
 * @param {import('vue').Ref<string>} options.currentPath
 * @param {ReturnType<import('./selection').createSelection>} options.selection
 * @param {(path: string) => Promise<unknown>} options.fetchPathItems
 * @param {(items: Array) => void} options.removeItemsFromCurrentView
 * @param {(item: object, options?: object) => void} options.beginRename
 * @param {() => void} options.refreshSizes  volume usage and folder sizes, later
 * @param {object} options.favoritesStore
 * @param {object} options.operationTasksStore
 * @param {(items: Array, action: string) => boolean} options.warn
 * @param {(result: object) => boolean} [options.sayWhatWasNotRead]  tells the
 *   reader how many entries an archive operation could not read, so an archive
 *   or an extraction short of files is never reported as finished
 */
export const createOperations = ({
  currentPath,
  selection,
  fetchPathItems,
  removeItemsFromCurrentView,
  beginRename,
  refreshSizes,
  favoritesStore,
  operationTasksStore,
  warn,
  sayWhatWasNotRead = () => false,
}) => {
  const refreshAfterCancelledOperation = async () => {
    await fetchPathItems(currentPath.value);
    refreshSizes();
  };

  // Favorites belong to an authenticated account. A guest share session
  // cannot refresh them, and doing so turns a successful delete into a
  // misleading authentication error.
  const refreshAfterDeletion = async () => {
    if (!currentPath.value.startsWith('share/')) {
      await Promise.all([favoritesStore.loadFavorites(), fetchPathItems(currentPath.value)]);
    } else {
      await fetchPathItems(currentPath.value);
    }
    refreshSizes();
  };

  const del = async (items = selection.selectedItems.value, options = {}) => {
    const payload = serializeItems(items);
    if (payload.length === 0) return;
    if (!options.onlyofficeWarningShown) {
      warn(items, 'Delete');
    }
    const payloadKeys = new Set(payload.map((item) => itemKey(item)));
    const selectionMatchesPayload =
      selection.selectedItems.value.length === payloadKeys.size &&
      selection.selectedItems.value.every((item) => payloadKeys.has(itemKey(item)));

    // Registered in the panel, stoppable, and fed the operation's own figures:
    // a deletion runs in the server now, so closing the tab no longer stops it
    // and hanging up no longer cancels it (see `stores/operationTasks`).
    const deleting = operationTasksStore.startServerOperation({
      type: 'delete',
      itemCount: payload.length,
    });

    try {
      const deletion = deleteItemsStream(payload, {
        permanent: options.permanent === true,
        onTask: deleting.onTask,
        onEvent: (event) => {
          deleting.onEvent(event);
          // What it is doing, which the bar says in words rather than numbers.
          if (event.type === 'start') {
            operationTasksStore.updateOperation(deleting.id, {
              phase: event.phase || 'preparing',
            });
          } else if (event.type === 'progress') {
            operationTasksStore.updateOperation(deleting.id, {
              phase: 'deleting',
              currentName: event.currentName || '',
            });
          }
        },
      });
      removeItemsFromCurrentView(payload);
      if (selectionMatchesPayload) selection.clearSelection();
      const response = await deletion;
      await refreshAfterDeletion();
      return response;
    } catch (error) {
      // Optimistic removal must always be reconciled after a rejected or
      // cancelled request. This restores the actual listing before surfacing
      // a server-side error to the caller.
      await refreshAfterDeletion();
      if (!isAbortError(error)) throw error;
      return null;
    } finally {
      deleting.finish();
    }
  };

  const createFolder = async (baseName) => {
    const destination = normalizePath(currentPath.value || '');
    const response = await createFolderApi(destination, baseName);

    await fetchPathItems(destination);
    refreshSizes();

    const createdItem = selection.selectCreated(destination, response?.item?.name);
    if (createdItem) beginRename(createdItem, { isNew: true });

    return response;
  };

  const createFile = async (baseName) => {
    const destination = normalizePath(currentPath.value || '');
    const response = await createFileApi(destination, baseName);

    // Refresh and start rename for the created item
    await fetchPathItems(destination);
    refreshSizes();

    const createdItem = selection.selectCreated(destination, response?.item?.name);
    if (createdItem) beginRename(createdItem, { isNew: true });

    return response;
  };

  /**
   * Create a blank office document in the current folder and return it.
   *
   * Unlike createFile, this does not start an inline rename: the name was
   * settled before the document existed, and the caller opens it in an editor
   * straight away — a rename box behind the editor overlay is a rename box
   * nobody can see.
   */
  const createOfficeDocument = async ({ format, name, extension } = {}) => {
    const destination = normalizePath(currentPath.value || '');
    const response = await createOfficeDocumentApi(destination, { format, name, extension });

    await fetchPathItems(destination);
    refreshSizes();

    const createdItem = selection.selectCreated(destination, response?.item?.name);
    return createdItem || response?.item || null;
  };

  const extractZipArchive = async (relativePath, options = {}) => {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) return null;

    const archiveName = normalized.split('/').pop() || normalized;
    const unpacking = operationTasksStore.startServerOperation({
      type: 'extract',
      name: archiveName,
      itemCount: 1,
    });

    let response;
    try {
      response = await extractZipApi(normalized, {
        destination: options.destination,
        password: options.password,
        suppressErrorCodes: ['ARCHIVE_PASSWORD_REQUIRED', 'ARCHIVE_INVALID_PASSWORD'],
        onEvent: unpacking.onEvent,
        onTask: unpacking.onTask,
      });
    } catch (error) {
      if (
        error?.code === 'ARCHIVE_PASSWORD_REQUIRED' ||
        error?.code === 'ARCHIVE_INVALID_PASSWORD'
      ) {
        return {
          requiresPassword: true,
          invalidPassword: error.code === 'ARCHIVE_INVALID_PASSWORD',
          path: normalized,
          destination: options.destination,
        };
      }
      if (!isAbortError(error)) throw error;
      await refreshAfterCancelledOperation();
      return null;
    } finally {
      unpacking.finish();
    }

    if (!response) return null;
    // The archive still holds whatever was left out, so nothing is lost — but
    // the folder is short of it, and nobody would know from the listing.
    sayWhatWasNotRead(response);

    const parent = (() => {
      const idx = normalized.lastIndexOf('/');
      return idx >= 0 ? normalized.slice(0, idx) : '';
    })();

    await fetchPathItems(parent);
    refreshSizes();

    selection.selectCreated(normalizePath(parent), response?.item?.name);

    return response;
  };

  const compressSelectionToZip = async (name) => {
    const destination = normalizePath(currentPath.value || '');
    const payload = serializeItems(selection.selectedItems.value);
    if (payload.length === 0) return null;
    const packing = operationTasksStore.startServerOperation({
      type: 'compress',
      destination,
      name: typeof name === 'string' && name.trim() ? name.trim() : '',
      itemCount: payload.length,
    });

    let response;
    try {
      response = await compressToZipApi(payload, destination, name, {
        onEvent: packing.onEvent,
        onTask: packing.onTask,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      await refreshAfterCancelledOperation();
      return null;
    } finally {
      packing.finish();
    }

    if (!response) return null;
    sayWhatWasNotRead(response);

    await fetchPathItems(destination);
    refreshSizes();

    const createdItem = selection.selectCreated(destination, response?.item?.name);
    if (createdItem) beginRename(createdItem, { isNew: true });

    return response;
  };

  return {
    del,
    createFolder,
    createFile,
    createOfficeDocument,
    extractZipArchive,
    compressSelectionToZip,
  };
};
