import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getDroppedFiles } from '@uppy/utils';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useAppSettings } from '@/stores/appSettings';
import { reserveFolderUploadTarget } from '@/api';
import { uploadPermission, uploadBlockedMessage } from './uploadTarget';
import { isDisallowedUpload } from '@/utils/uploads';
import {
  createErrorNotifier,
  createUploadBatchId,
  getUploadFallbackMiB,
  resetUploadFallback,
} from './uploadCommon';

// Where the settings screen and its tests have always found them.
export { getUploadFallbackMiB, resetUploadFallback };

/**
 * Uploading, without Uppy on the page that loads first.
 *
 * Uppy and its two uploaders are a few hundred kilobytes, and every page used
 * to carry them because the layout built the instance on mounting. They live
 * in `uploadEngine.js` now, fetched the first time an upload is about to
 * happen: when the picker opens — while the person is choosing, so it is
 * there by the time they have chosen — and when a file is dragged over the
 * page. Files are handed over only once it has returned.
 *
 * The picker is still opened inside the click that asked for it; a browser
 * refuses a file dialog opened after waiting on the network.
 */

let enginePromise = null;
let ownerClaimed = false;

const LOAD_FAILED = 'The uploader could not be loaded. Reload the page and try the upload again.';

/**
 * The one upload engine, loaded and built on first use.
 *
 * A failed load is forgotten so the next attempt can try again — a deploy
 * between two uploads replaces the file this would have fetched.
 */
export const loadUploadEngine = () => {
  if (!enginePromise) {
    enginePromise = import('./uploadEngine')
      .then(({ createUploadEngine }) => createUploadEngine())
      .catch((error) => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
};

const releaseUploadEngine = () => {
  const pending = enginePromise;
  enginePromise = null;
  pending?.then((engine) => engine.destroy()).catch(() => {});
};

export function useFileUploader() {
  const fileStore = useFileStore();
  const notificationsStore = useNotificationsStore();
  const appSettings = useAppSettings();
  const inputRef = ref(null);
  const files = ref([]);
  const notifyErrorOnce = createErrorNotifier(notificationsStore);

  // The first to ask owns the uploads for as long as it is mounted — the
  // layout, which is set up before anything inside it. A dialog that comes and
  // goes with a toolbar must not take them down with it.
  const owner = !ownerClaimed;
  if (owner) ownerClaimed = true;

  /** The decision and its reason together, from one rule rather than two. */
  const currentUploadPermission = () =>
    uploadPermission(fileStore.currentPathData, fileStore.currentPath);

  const canUploadToCurrentPath = () => currentUploadPermission().allowed;

  const blockedMessage = () => uploadBlockedMessage(currentUploadPermission().reason);

  function uppyFile(file, meta = {}) {
    return {
      name: file.name,
      type: file.type,
      data: file,
      meta,
    };
  }

  function setDialogAttributes(options) {
    inputRef.value.accept = options.accept;
    inputRef.value.multiple = options.multiple;
    inputRef.value.webkitdirectory = !!options.directory;
    inputRef.value.directory = !!options.directory;
    inputRef.value.mozdirectory = !!options.directory;
  }

  async function openDialog(opts) {
    const defaultDialogOptions = {
      multiple: true,
      accept: '*',
    };

    if (!canUploadToCurrentPath()) {
      notifyErrorOnce(blockedMessage(), { durationMs: 5000 });
      return Promise.resolve();
    }

    // Fetched while the person is choosing, and not waited on before the
    // picker opens.
    const engineReady = loadUploadEngine();
    engineReady.catch(() => {});

    try {
      await appSettings.ensureLoaded();
    } catch (_) {
      // Keep upload available with safe defaults if settings cannot be loaded.
    }

    return new Promise((resolve) => {
      if (!inputRef.value) {
        notificationsStore.addNotification({
          type: 'error',
          heading: 'File picker is not ready yet. Please try again.',
          durationMs: 3000,
        });
        resolve();
        return;
      }

      files.value = [];
      const options = { ...defaultDialogOptions, ...opts };

      setDialogAttributes(options);

      inputRef.value.onchange = async (e) => {
        const selectedFiles = Array.from(e.target.files || []).filter(
          (file) => !isDisallowedUpload(file.name)
        );

        const uploadBatchId = createUploadBatchId();
        const firstRelativePath = selectedFiles[0]?.webkitRelativePath || '';
        const sourceRoot = firstRelativePath.split('/').filter(Boolean)[0] || '';
        let targetRoot = '';

        if (options.directory && selectedFiles.length > 0 && !sourceRoot) {
          notifyErrorOnce('Your browser did not provide the selected folder structure.');
          e.target.value = '';
          resolve();
          return;
        }

        if (options.directory && selectedFiles.length > 0) {
          try {
            const reservation = await reserveFolderUploadTarget(fileStore.currentPath, sourceRoot);
            targetRoot = reservation?.targetRoot || '';
            if (!targetRoot) throw new Error('The server did not reserve a destination folder.');
          } catch (err) {
            notifyErrorOnce(err?.message || 'Unable to reserve the destination folder.');
            e.target.value = '';
            resolve();
            return;
          }
        }

        files.value = selectedFiles.map((file) => {
          const relativePath = file.webkitRelativePath || file.name;
          const parts = relativePath.split('/').filter(Boolean);
          const resolvedRelativePath =
            targetRoot && parts.length > 0 ? [targetRoot, ...parts.slice(1)].join('/') : '';
          return uppyFile(file, {
            uploadBatchId,
            ...(resolvedRelativePath ? { resolvedRelativePath } : {}),
          });
        });

        try {
          const engine = await engineReady;
          engine.addPickedFiles(files.value);
        } catch (_) {
          notifyErrorOnce(LOAD_FAILED);
        }

        // Reset the input so the same file can be selected again if needed
        e.target.value = '';
        resolve();
      };

      inputRef.value.click();
    });
  }

  onMounted(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'hidden';
    document.body.appendChild(input);
    inputRef.value = input;
  });

  onBeforeUnmount(() => {
    inputRef.value?.remove();
    if (owner) {
      ownerClaimed = false;
      releaseUploadEngine();
    }
  });

  return {
    files,
    openDialog,
  };
}

const isFileTransfer = (event) =>
  Array.from(event?.dataTransfer?.types || []).some((type) => type === 'Files');

/**
 * Files dropped onto an element, from the desktop.
 *
 * The element answers a file drag itself, whether or not the engine has been
 * loaded: a browser that is not told otherwise opens a dropped file in place
 * of the page. The engine is fetched as soon as a file is dragged over, and a
 * drop that comes first waits for it. What was dropped is read during the drop
 * itself, which is the only moment a browser allows it, and handed over once
 * the engine is there.
 *
 * Only drags that carry files: moving entries within the explorer is
 * somebody else's business, and passes through untouched.
 */
export function useUppyDropTarget(targetRef) {
  const notificationsStore = useNotificationsStore();
  const notifyErrorOnce = createErrorNotifier(notificationsStore);
  let node = null;

  const onDragOver = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    // Add a small (+) icon on drop, and keep the browser from treating it as
    // a move of the files into the page.
    event.dataTransfer.dropEffect = 'copy';
    event.currentTarget?.classList.add('uppy-is-drag-over');
    loadUploadEngine().catch(() => {});
  };

  const onDragLeave = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.classList.remove('uppy-is-drag-over');
  };

  const onDrop = async (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.classList.remove('uppy-is-drag-over');

    // Before anything is waited on: the entries of a drop are only readable
    // while the drop event is being handled.
    const dropped = getDroppedFiles(event.dataTransfer, {
      logDropError: (error) =>
        notifyErrorOnce(error?.message || 'A dropped item could not be read.'),
    });

    let engine;
    let droppedFiles;
    try {
      [engine, droppedFiles] = await Promise.all([loadUploadEngine(), dropped]);
    } catch (_) {
      notifyErrorOnce(LOAD_FAILED);
      return;
    }
    if (droppedFiles.length > 0) engine.addDroppedFiles(droppedFiles);
  };

  onMounted(() => {
    const el = targetRef && 'value' in targetRef ? targetRef.value : null;
    if (!el) return;
    node = el;
    node.addEventListener('dragover', onDragOver, false);
    node.addEventListener('dragleave', onDragLeave, false);
    node.addEventListener('drop', onDrop, false);
  });

  onBeforeUnmount(() => {
    if (!node) return;
    node.removeEventListener('dragover', onDragOver, false);
    node.removeEventListener('dragleave', onDragLeave, false);
    node.removeEventListener('drop', onDrop, false);
    node = null;
  });
}
