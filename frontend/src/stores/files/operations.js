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

    const controller = new AbortController();
    const operationId = operationTasksStore.startOperation({
      type: 'delete',
      itemCount: payload.length,
      cancellable: true,
      cancel: () => controller.abort(),
    });

    try {
      const deletion = deleteItemsStream(payload, {
        signal: controller.signal,
        permanent: options.permanent === true,
        onEvent: (event) => {
          if (event.type === 'start') {
            operationTasksStore.updateOperation(operationId, {
              phase: event.phase || 'preparing',
              totalItems: Number(event.totalItems) || payload.length,
            });
          } else if (event.type === 'progress') {
            operationTasksStore.updateOperation(operationId, {
              phase: 'deleting',
              percent: Number(event.percent) || 0,
              completedItems: Number(event.completedItems) || 0,
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
      operationTasksStore.finishOperation(operationId);
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
  const createOfficeDocument = async ({ format, name } = {}) => {
    const destination = normalizePath(currentPath.value || '');
    const response = await createOfficeDocumentApi(destination, { format, name });

    await fetchPathItems(destination);
    refreshSizes();

    const createdItem = selection.selectCreated(destination, response?.item?.name);
    return createdItem || response?.item || null;
  };

  const extractZipArchive = async (relativePath, options = {}) => {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) return null;

    const archiveName = normalized.split('/').pop() || normalized;
    const controller = new AbortController();
    const operationId = operationTasksStore.startOperation({
      type: 'extract',
      name: archiveName,
      itemCount: 1,
      cancellable: true,
      cancel: () => controller.abort(),
    });

    let response;
    try {
      response = await extractZipApi(normalized, {
        destination: options.destination,
        password: options.password,
        suppressErrorCodes: ['ARCHIVE_PASSWORD_REQUIRED', 'ARCHIVE_INVALID_PASSWORD'],
        onEvent: (event) => {
          if (event?.type === 'progress' && Number.isFinite(event.percent)) {
            operationTasksStore.updateOperation(operationId, { percent: event.percent });
          }
        },
        signal: controller.signal,
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
      operationTasksStore.finishOperation(operationId);
    }

    if (!response) return null;

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
    const controller = new AbortController();

    const operationId = operationTasksStore.startOperation({
      type: 'compress',
      name: typeof name === 'string' && name.trim() ? name.trim() : '',
      itemCount: payload.length,
      cancellable: true,
      cancel: () => controller.abort(),
    });

    let response;
    try {
      response = await compressToZipApi(payload, destination, name, {
        onEvent: (event) => {
          if (event?.type === 'start' && event.name) {
            operationTasksStore.updateOperation(operationId, { name: event.name });
          } else if (event?.type === 'progress' && Number.isFinite(event.percent)) {
            operationTasksStore.updateOperation(operationId, { percent: event.percent });
          }
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      await refreshAfterCancelledOperation();
      return null;
    } finally {
      operationTasksStore.finishOperation(operationId);
    }

    if (!response) return null;

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
