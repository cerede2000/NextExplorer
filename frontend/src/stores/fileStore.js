import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useStorage } from '@vueuse/core';
import router from '@/router';
import {
  browse,
  copyItems,
  moveItems,
  deleteItems,
  normalizePath,
  createFolder as createFolderApi,
  renameItem as renameItemApi,
  saveFileContent as saveFileContentApi,
  fetchThumbnail as fetchThumbnailApi,
  extractZip as extractZipApi,
  compressToZip as compressToZipApi,
  browseShare,
} from '@/api';
import { useSettingsStore } from '@/stores/settings';
import { useAppSettings } from '@/stores/appSettings';
import { useFavoritesStore } from '@/stores/favorites';
import { useVolumeUsageStore } from '@/stores/volumeUsage';
import { useFolderSizeStore } from '@/stores/folderSize';

export const useFileStore = defineStore('fileStore', () => {
  // How many thumbnail HTTP requests the client keeps in flight at once. The
  // backend keeps navigation responsive under load (enlarged libuv pool + niced
  // ffmpeg/convert children + bounded background queue), so the client can feed
  // it several requests concurrently instead of trickling them two at a time.
  const THUMBNAIL_REQUEST_CONCURRENCY = 6;

  // State
  const currentPath = ref('');
  const currentPathItems = ref([]);
  const currentPathData = ref(null);
  const selectedItems = ref([]);
  const selectionMode = ref(false);
  const renameState = ref(null);

  const clipboardOperation = ref(null);
  const deleteOperation = ref(null);
  const extractOperation = ref(null);
  const favoritesStore = useFavoritesStore();
  const volumeUsageStore = useVolumeUsageStore();
  const folderSizeStore = useFolderSizeStore();

  const copiedItems = useStorage('nextExplorer_clipboard_copied', []);
  const cutItems = useStorage('nextExplorer_clipboard_cut', []);
  // When true, a finished copy/move re-focuses the pasted entry in its destination
  // folder (navigating there via the router so the address bar stays in sync).
  // When false, the current view is left untouched — handy for launching a long
  // transfer and continuing to browse elsewhere. Persisted across sessions.
  const repositionAfterTransfer = useStorage('nextExplorer_paste_reposition', true);
  const thumbnailRequests = new Map();
  const thumbnailRequestQueue = [];
  const activeThumbnailControllers = new Set();
  let activeThumbnailRequestCount = 0;
  let thumbnailQueueGeneration = 0;

  const hasSelection = computed(() => selectedItems.value.length > 0);
  const selectedItemKeys = computed(() => {
    const keys = new Set();
    for (const item of selectedItems.value) {
      const key = itemKey(item);
      if (key) keys.add(key);
    }
    return keys;
  });
  const hasClipboardItems = computed(
    () => copiedItems.value.length > 0 || cutItems.value.length > 0
  );

  const clearSelection = () => {
    selectedItems.value = [];
  };

  const setSelectionMode = (enabled, options = {}) => {
    selectionMode.value = Boolean(enabled);

    const clearOnDisable = options?.clearOnDisable ?? true;
    if (!selectionMode.value && clearOnDisable) {
      clearSelection();
    }
  };

  const toggleSelectionMode = (options = {}) => {
    setSelectionMode(!selectionMode.value, options);
  };

  const itemKey = (item) => {
    if (!item || !item.name) {
      return '';
    }

    const parent = normalizePath(item.path || '');
    return `${parent}::${item.name}`;
  };

  const findItemByKey = (key) => currentPathItems.value.find((item) => itemKey(item) === key);

  const resolveItemRelativePath = (item) => {
    if (!item || !item.name) {
      return null;
    }

    const parent = normalizePath(item.path || '');
    const combined = parent ? `${parent}/${item.name}` : item.name;
    return normalizePath(combined);
  };

  const isAbortError = (error) =>
    error?.name === 'AbortError' ||
    (typeof DOMException !== 'undefined' && error?.code === DOMException.ABORT_ERR) ||
    /aborted/i.test(error?.message || '');

  const pumpThumbnailRequestQueue = () => {
    while (
      activeThumbnailRequestCount < THUMBNAIL_REQUEST_CONCURRENCY &&
      thumbnailRequestQueue.length > 0
    ) {
      const task = thumbnailRequestQueue.shift();

      if (!task || task.generation !== thumbnailQueueGeneration) {
        task?.resolve?.(null);
        continue;
      }

      const controller = new AbortController();
      activeThumbnailControllers.add(controller);
      activeThumbnailRequestCount += 1;

      task
        .run(controller.signal)
        .then(task.resolve)
        .catch((error) => {
          if (!isAbortError(error)) {
            task.reject(error);
            return;
          }
          task.resolve(null);
        })
        .finally(() => {
          activeThumbnailRequestCount = Math.max(0, activeThumbnailRequestCount - 1);
          activeThumbnailControllers.delete(controller);
          thumbnailRequests.delete(task.key);
          pumpThumbnailRequestQueue();
        });
    }
  };

  const queueThumbnailRequest = (key, run) =>
    new Promise((resolve, reject) => {
      thumbnailRequestQueue.push({
        key,
        generation: thumbnailQueueGeneration,
        run,
        resolve,
        reject,
      });
      pumpThumbnailRequestQueue();
    });

  const cancelThumbnailRequests = () => {
    thumbnailQueueGeneration += 1;

    const queued = thumbnailRequestQueue.splice(0);
    for (const task of queued) {
      thumbnailRequests.delete(task.key);
      task.resolve(null);
    }

    for (const controller of activeThumbnailControllers) {
      controller.abort();
    }
  };

  const serializeItems = (items) =>
    items
      .filter((item) => item && item.name && item.kind !== 'volume')
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || ''),
        kind: item.kind,
      }));

  const resetClipboard = () => {
    copiedItems.value = [];
    cutItems.value = [];
  };

  const copy = () => {
    if (!hasSelection.value) return;
    cutItems.value = [];
    copiedItems.value = selectedItems.value.map((item) => ({ ...item }));
  };

  const cut = () => {
    if (!hasSelection.value) return;
    copiedItems.value = [];
    cutItems.value = selectedItems.value.map((item) => ({ ...item }));
  };

  // Final name of a copied/moved entry, from its destination-relative path.
  const transferredBaseName = (relativePath) => {
    const normalized = normalizePath(relativePath || '');
    const idx = normalized.lastIndexOf('/');
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
  };

  // Collect the final entry names from a streamed transfer result ({ items:[{ to }] }).
  const collectTransferredNames = (result, out) => {
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const entry of items) {
      const name = transferredBaseName(entry?.to);
      if (name) out.push(name);
    }
  };

  const selectItemsByName = (names) => {
    const wanted = new Set((names || []).filter(Boolean));
    if (wanted.size === 0) return;
    const matches = currentPathItems.value.filter((it) => it && wanted.has(it.name));
    if (matches.length > 0) {
      selectedItems.value = matches;
    }
  };

  // Refresh the view (and optionally reposition) once a copy/move settles. The
  // address bar is driven by the router, so "repositioning" navigates through the
  // router to keep the URL/breadcrumb in sync with the listing. When repositioning
  // is disabled we only refresh the folder the user is *currently* viewing (which
  // always matches the route), so navigating away mid-transfer is never disrupted.
  const settleAfterTransfer = async (finalDestination, moveSourceParents, pastedNames) => {
    const userLocation = normalizePath(currentPath.value || '');
    const onDestination = userLocation === finalDestination;

    if (repositionAfterTransfer.value) {
      if (onDestination || !finalDestination) {
        // Already at the destination (or destination is the root, which has no
        // routable path): refresh in place and highlight the result. The address
        // bar is already correct, so no navigation is needed.
        await fetchPathItems(userLocation);
        selectItemsByName(pastedNames);
      } else {
        // Elsewhere (navigated away, or pasted into another folder): navigate to
        // the destination and select the entry, which also updates the address bar.
        const firstName = pastedNames[0];
        router
          .push({
            name: 'FolderView',
            params: { path: finalDestination },
            ...(firstName ? { query: { select: firstName } } : {}),
          })
          .catch(() => {});
      }
      return;
    }

    // Repositioning disabled: leave the user where they are. Refresh only when the
    // current folder was actually affected (it is the destination, or a move source
    // that just lost entries) so its listing stays accurate without any view jump.
    if (onDestination || moveSourceParents.has(userLocation)) {
      await fetchPathItems(userLocation);
    }
  };

  const paste = async (targetPath) => {
    const hasTarget = typeof targetPath === 'string' && targetPath.trim().length > 0;
    const destination = normalizePath(hasTarget ? targetPath : currentPath.value || '');

    const copyPayload = serializeItems(copiedItems.value);
    const movePayload = serializeItems(cutItems.value);
    const moveSourceParents = new Set(
      movePayload.map((item) => normalizePath(item.path || ''))
    );
    const totalCount = copyPayload.length + movePayload.length;

    if (totalCount > 0) {
      clipboardOperation.value = {
        type: movePayload.length > 0 && copyPayload.length === 0 ? 'move' : 'copy',
        destination,
        itemCount: totalCount,
        startedAt: Date.now(),
        totalBytes: 0,
        copiedBytes: 0,
      };
    }

    // Fold streamed transfer events into the reactive operation so the progress
    // bar tracks real bytes copied against the pre-computed total.
    const onTransferEvent = (event) => {
      const op = clipboardOperation.value;
      if (!op || !event) return;
      if (event.type === 'start') {
        op.totalBytes = Number(event.totalBytes) || 0;
        op.copiedBytes = 0;
      } else if (event.type === 'progress') {
        if (event.totalBytes != null) op.totalBytes = Number(event.totalBytes) || 0;
        op.copiedBytes = Number(event.copiedBytes) || 0;
      }
    };

    try {
      const pastedNames = [];
      let finalDestination = destination;

      if (copiedItems.value.length > 0) {
        if (copyPayload.length > 0) {
          const result = await copyItems(copyPayload, destination, { onEvent: onTransferEvent });
          collectTransferredNames(result, pastedNames);
          if (result?.destination != null) finalDestination = normalizePath(result.destination);
        }
        copiedItems.value = [];
      }

      if (cutItems.value.length > 0) {
        if (movePayload.length > 0) {
          const result = await moveItems(movePayload, destination, { onEvent: onTransferEvent });
          collectTransferredNames(result, pastedNames);
          if (result?.destination != null) finalDestination = normalizePath(result.destination);
        }
        cutItems.value = [];
      }

      await settleAfterTransfer(finalDestination, moveSourceParents, pastedNames);
      volumeUsageStore.scheduleRefresh();
      folderSizeStore.scheduleRefresh();
    } finally {
      clipboardOperation.value = null;
    }
  };

  const del = async () => {
    const payload = serializeItems(selectedItems.value);
    if (payload.length === 0) return;

    deleteOperation.value = {
      type: 'delete',
      itemCount: payload.length,
      startedAt: Date.now(),
    };

    try {
      await deleteItems(payload);
      clearSelection();
      await favoritesStore.loadFavorites();
      await fetchPathItems(currentPath.value);
      volumeUsageStore.scheduleRefresh();
      folderSizeStore.scheduleRefresh();
    } finally {
      deleteOperation.value = null;
    }
  };

  const createFolder = async (baseName) => {
    const destination = normalizePath(currentPath.value || '');
    const response = await createFolderApi(destination, baseName);
    const createdName = response?.item?.name;

    await fetchPathItems(destination);
    volumeUsageStore.scheduleRefresh();
    folderSizeStore.scheduleRefresh();

    if (createdName) {
      const createdKey = `${destination}::${createdName}`;
      const createdItem = findItemByKey(createdKey);
      if (createdItem) {
        selectedItems.value = [createdItem];
        beginRename(createdItem, { isNew: true });
      }
    }

    return response;
  };

  const createFile = async (baseName) => {
    const destination = normalizePath(currentPath.value || '');

    // Determine a default base name and extension
    const defaultName =
      typeof baseName === 'string' && baseName.trim() ? baseName.trim() : 'Untitled.txt';

    // Split name into stem + extension (preserve provided extension if present)
    const lastDot = defaultName.lastIndexOf('.');
    const stem = lastDot > 0 ? defaultName.slice(0, lastDot) : defaultName;
    const ext = lastDot > 0 ? defaultName.slice(lastDot) : '';

    // Ensure the name is unique in current listing
    const existingNames = new Set(
      (currentPathItems.value || []).map((it) => it?.name).filter(Boolean)
    );
    let candidate = `${stem}${ext}`;
    let counter = 2;
    while (existingNames.has(candidate)) {
      candidate = `${stem} ${counter}${ext}`;
      counter += 1;
    }

    const relativePath = destination ? `${destination}/${candidate}` : candidate;

    // Create empty file
    await saveFileContentApi(relativePath, '');

    // Refresh and start rename for the created item
    await fetchPathItems(destination);
    volumeUsageStore.scheduleRefresh();
    folderSizeStore.scheduleRefresh();

    const createdKey = `${destination}::${candidate}`;
    const createdItem = findItemByKey(createdKey);
    if (createdItem) {
      selectedItems.value = [createdItem];
      beginRename(createdItem, { isNew: true });
    }

    return { success: true, name: candidate };
  };

  const extractZipArchive = async (relativePath) => {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) return null;

    const archiveName = normalized.split('/').pop() || normalized;
    extractOperation.value = {
      type: 'extract',
      name: archiveName,
      itemCount: 1,
      startedAt: Date.now(),
      percent: null,
    };

    let response;
    try {
      response = await extractZipApi(normalized, {
        onEvent: (event) => {
          if (event?.type === 'progress' && Number.isFinite(event.percent)) {
            extractOperation.value = { ...extractOperation.value, percent: event.percent };
          }
        },
      });
    } finally {
      extractOperation.value = null;
    }

    const parent = (() => {
      const idx = normalized.lastIndexOf('/');
      return idx >= 0 ? normalized.slice(0, idx) : '';
    })();

    await fetchPathItems(parent);
    volumeUsageStore.scheduleRefresh();
    folderSizeStore.scheduleRefresh();

    const createdName = response?.item?.name;
    if (createdName) {
      const createdKey = `${normalizePath(parent)}::${createdName}`;
      const createdItem = findItemByKey(createdKey);
      if (createdItem) {
        selectedItems.value = [createdItem];
      }
    }

    return response;
  };

  const compressSelectionToZip = async (name) => {
    const destination = normalizePath(currentPath.value || '');
    const payload = serializeItems(selectedItems.value);
    if (payload.length === 0) return null;

    const response = await compressToZipApi(payload, destination, name);
    const createdName = response?.item?.name;

    await fetchPathItems(destination);
    volumeUsageStore.scheduleRefresh();
    folderSizeStore.scheduleRefresh();

    if (createdName) {
      const createdKey = `${destination}::${createdName}`;
      const createdItem = findItemByKey(createdKey);
      if (createdItem) {
        selectedItems.value = [createdItem];
        beginRename(createdItem, { isNew: true });
      }
    }

    return response;
  };

  const beginRename = (item, options = {}) => {
    if (!item || !item.name) return;

    const key = itemKey(item);
    const existing = findItemByKey(key);
    const target = existing || { ...item };

    selectedItems.value = [target];

    renameState.value = {
      key,
      path: normalizePath(target.path || currentPath.value || ''),
      originalName: target.name,
      draft: target.name,
      kind: target.kind,
      isNew: Boolean(options.isNew),
    };
  };

  const setRenameDraft = (value) => {
    if (!renameState.value) return;
    renameState.value.draft = value;
  };

  const cancelRename = () => {
    renameState.value = null;
  };

  const applyRename = async () => {
    const state = renameState.value;
    if (!state) return;

    const newName = state.draft ?? '';
    if (!newName.trim()) {
      renameState.value = null;
      return;
    }

    if (newName === state.originalName) {
      renameState.value = null;
      return;
    }

    const targetPath = state.path;

    const response = await renameItemApi(targetPath, state.originalName, newName);
    const renamedName = response?.item?.name ?? newName;
    renameState.value = null;
    await fetchPathItems(targetPath);
    const renamedKey = `${targetPath}::${renamedName}`;
    const renamedItem = findItemByKey(renamedKey);
    if (renamedItem) {
      selectedItems.value = [renamedItem];
    }
  };

  const isItemBeingRenamed = (item) => {
    if (!renameState.value) return false;
    return itemKey(item) === renameState.value.key;
  };

  const ensureItemThumbnail = async (item) => {
    if (!item || !item.name) {
      return null;
    }

    const kind = (item.kind || '').toLowerCase();
    if (kind === 'directory' || kind === 'pdf') {
      return null;
    }

    // Check if item supports thumbnails (set by backend)
    if (!item.supportsThumbnail) {
      return null;
    }

    try {
      const appSettings = useAppSettings();
      if (appSettings.thumbnailsEnabledForSession === false) {
        return null;
      }
    } catch (e) {
      // If settings store fails, fail open to avoid breaking UI, but do not spam
    }

    const key = itemKey(item);
    if (!key) {
      return null;
    }

    const existing = findItemByKey(key);
    if (existing?.thumbnail) {
      return existing.thumbnail;
    }

    let pending = thumbnailRequests.get(key);
    if (!pending) {
      const relativePath = resolveItemRelativePath(item);
      if (!relativePath) {
        return null;
      }

      pending = queueThumbnailRequest(key, async (signal) => {
        try {
          const response = await fetchThumbnailApi(relativePath, {
            signal,
            retryNetworkErrors: false,
          });
          const thumbnail = response?.thumbnail || '';
          if (thumbnail) {
            const target = findItemByKey(key);
            if (target) {
              target.thumbnail = thumbnail;
            }
            return thumbnail;
          }
          // No thumbnail yet: only keep polling when the server reported the job
          // as pending. Anything else is a definitive "no thumbnail" (unsupported
          // type, generation failed) — mark it so the icon stops re-requesting.
          if (!response?.pending) {
            const target = findItemByKey(key);
            if (target) {
              target.thumbnailUnavailable = true;
            }
          }
          return null;
        } catch (error) {
          // Aborted on navigation is not a failure — allow a later attempt.
          if (isAbortError(error)) {
            return null;
          }
          // Hard failure (404 missing source, other 4xx/5xx). These are silent,
          // best-effort fetches; mark the item so we never loop on the error.
          const target = findItemByKey(key);
          if (target) {
            target.thumbnailUnavailable = true;
          }
          return null;
        }
      });

      thumbnailRequests.set(key, pending);
    }

    return pending;
  };

  const getCurrentPath = computed(() => currentPath.value);

  // When sorting by size, directories must be ranked by their pre-computed
  // recursive size (from the folder size index), not by the near-zero directory
  // inode size on `item.size` — otherwise the sort order does not match the
  // sizes shown in the UI.
  const sortValue = (item, key) => {
    if (key === 'size') {
      if (item.kind === 'directory') {
        const full = item.path ? `${item.path}/${item.name}` : item.name;
        const entry = folderSizeStore.sizeFor(full);
        if (entry && entry.sizeBytes != null) return entry.sizeBytes;
      }
      return Number(item.size) || 0;
    }
    return item[key];
  };

  const getCurrentPathItems = computed(() => {
    const settings = useSettingsStore();
    const direction = settings.sortBy.order === 'asc' ? 1 : -1;
    const sortKey = settings.sortBy.by;

    return [...currentPathItems.value].sort((a, b) => {
      // keep directories first
      const isDirDiff = (b.kind === 'directory') - (a.kind === 'directory');
      if (isDirDiff) return isDirDiff; // returns -1 or 1

      const aValue = sortValue(a, sortKey);
      const bValue = sortValue(b, sortKey);
      if (aValue === bValue) return 0;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return aValue.localeCompare(bValue, undefined, { sensitivity: 'base' }) * direction;
      }
      return (aValue > bValue ? 1 : -1) * direction;
    });
  });

  // Actions
  function setCurrentPath(path) {
    currentPath.value = normalizePath(path);
  }

  async function fetchPathItems(path) {
    const previousItems = Array.isArray(currentPathItems.value) ? currentPathItems.value : [];

    const normalizedPath = normalizePath(typeof path === 'string' ? path : currentPath.value);
    cancelThumbnailRequests();
    currentPath.value = normalizedPath;
    clearSelection();
    // When changing folders, exit selection mode (mobile UX).
    setSelectionMode(false, { clearOnDisable: false });

    let response;

    // For share paths, use the dedicated share browse endpoint so that
    // file shares can be treated as virtual one-item directories.
    if (normalizedPath && normalizedPath.startsWith('share/')) {
      const segments = normalizedPath.split('/');
      const shareToken = segments[1];
      const innerPath = segments.slice(2).join('/');
      response = await browseShare(shareToken, innerPath);
    } else {
      response = await browse(normalizedPath);
    }

    // Merge new items into existing list by stable key so that
    // unchanged entries keep their object identity (and any local
    // UI fields such as thumbnails), while still updating metadata
    // and adding/removing items as needed.
    const mergeItems = (items) => {
      if (!Array.isArray(items)) return [];

      const existingByKey = new Map(
        previousItems.filter((it) => it && it.name).map((it) => [itemKey(it), it])
      );

      const merged = [];

      for (const incoming of items) {
        if (!incoming || !incoming.name) continue;

        const key = itemKey(incoming);
        const existing = existingByKey.get(key);

        if (existing) {
          // Preserve any locally-added thumbnail if the backend
          // does not send one, but refresh all other metadata.
          const prevThumbnail = existing.thumbnail;
          Object.assign(existing, incoming);
          if (!incoming.thumbnail && prevThumbnail) {
            existing.thumbnail = prevThumbnail;
          }
          // `supportsThumbnail` can be toggled by system settings; if the backend does not
          // include it for an item, treat it as false so we don't keep stale truthy values.
          existing.supportsThumbnail = Boolean(incoming.supportsThumbnail);
          merged.push(existing);
        } else {
          merged.push(incoming);
        }
      }

      return merged;
    };

    // Handle new response format with items and access metadata
    if (response && typeof response === 'object' && Array.isArray(response.items)) {
      currentPathItems.value = mergeItems(response.items);
      const access =
        response.access && typeof response.access === 'object' ? response.access : null;
      currentPathData.value = {
        path: response.path || normalizedPath,
        canRead: access?.canRead ?? true,
        // If the backend doesn't include access metadata, fail open so the UI
        // doesn't hide core actions for older response formats.
        canWrite: access?.canWrite ?? true,
        canUpload: access?.canUpload ?? true,
        canDelete: access?.canDelete ?? true,
        canShare: access?.canShare ?? true,
        canDownload: access?.canDownload ?? true,
        isDirectory: response.current?.isDirectory ?? null,
        // Include share metadata if present
        shareInfo: response.shareInfo || null,
      };
    } else {
      // Fallback for old response format (array of items)
      currentPathItems.value = mergeItems(Array.isArray(response) ? response : []);
      currentPathData.value = null;
    }

    return currentPathItems.value;
  }

  return {
    currentPath,
    getCurrentPath,
    setCurrentPath,
    currentPathItems,
    currentPathData,
    getCurrentPathItems,
    fetchPathItems,
    selectedItems,
    selectedItemKeys,
    selectionMode,
    setSelectionMode,
    toggleSelectionMode,
    clearSelection,
    clipboardOperation,
    deleteOperation,
    repositionAfterTransfer,
    extractOperation,
    copiedItems,
    cutItems,
    hasSelection,
    hasClipboardItems,
    copy,
    cut,
    paste,
    del,
    resetClipboard,
    createFolder,
    createFile,
    extractZipArchive,
    compressSelectionToZip,
    renameState,
    beginRename,
    setRenameDraft,
    cancelRename,
    applyRename,
    isItemBeingRenamed,
    ensureItemThumbnail,
  };
});
