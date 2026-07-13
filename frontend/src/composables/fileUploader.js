import { ref, onMounted, onBeforeUnmount, markRaw } from 'vue';
import Uppy from '@uppy/core';
import XHRUpload from '@uppy/xhr-upload';
import Tus from '@uppy/tus';
import { useUppyStore } from '@/stores/uppyStore';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useAppSettings } from '@/stores/appSettings';
import { apiBase, normalizePath } from '@/api';
import { isDisallowedUpload } from '@/utils/uploads';
import DropTarget from '@uppy/drop-target';

// Per-origin remembered auto-fallback chunk size (localStorage is scoped to the
// origin, so the public URL and a LAN IP each keep their own value). Exported so
// the settings screen can reset it (revert this origin to direct uploads).
export const UPLOAD_FALLBACK_STORAGE_KEY = 'nextExplorer_upload_fallback_chunk_mib';

export const getUploadFallbackMiB = () => {
  try {
    const value = Number(localStorage.getItem(UPLOAD_FALLBACK_STORAGE_KEY));
    return Number.isFinite(value) && value >= 1 ? value : null;
  } catch (_) {
    return null;
  }
};

export const resetUploadFallback = () => {
  try {
    localStorage.removeItem(UPLOAD_FALLBACK_STORAGE_KEY);
  } catch (_) {
    /* noop */
  }
};

export function useFileUploader() {
  // Filtering is centralized in utils/uploads
  const uppyStore = useUppyStore();
  const fileStore = useFileStore();
  const notificationsStore = useNotificationsStore();
  const appSettings = useAppSettings();
  const inputRef = ref(null);
  const files = ref([]);

  let lastNotifyAt = 0;
  let lastNotifyKey = '';
  let uploadPluginMode = null;

  const canUploadToCurrentPath = () => {
    const access = fileStore.currentPathData;
    if (!access) {
      // If share metadata hasn't loaded yet, fail closed to avoid accidental uploads.
      return !String(fileStore.currentPath || '').startsWith('share/');
    }
    return access.canUpload !== false;
  };

  const uploadBlockedMessage = () => {
    const access = fileStore.currentPathData;
    if (!access && String(fileStore.currentPath || '').startsWith('share/')) {
      return 'Share is still loading. Please try again in a moment.';
    }
    if (access?.shareInfo?.accessMode === 'readonly') {
      return 'This share is read-only. Uploads are disabled.';
    }
    return 'You do not have permission to upload to this location.';
  };

  const notifyErrorOnce = (heading, extra = {}) => {
    const now = Date.now();
    const { dedupeKey, dedupeMs = 10000, ...notificationExtra } = extra;
    const key = dedupeKey || heading;
    if (key === lastNotifyKey && now - lastNotifyAt < dedupeMs) return;
    lastNotifyAt = now;
    lastNotifyKey = key;
    notificationsStore.addNotification({ type: 'error', heading, ...notificationExtra });
  };

  // Ensure a single Uppy instance app-wide
  let uppy = uppyStore.uppy;
  const createdHere = ref(false);

  const MIB_BYTES = 1024 * 1024;
  // Chunk sizes tried on fallback (largest first, near the value that works
  // manually). Each PATCH stays well under a typical reverse-proxy body limit.
  const FALLBACK_LADDER_MIB = [96, 64, 32, 16, 8];
  // A direct upload that makes no progress for this long is considered stalled
  // (a proxy that silently stops reading an over-limit body never errors).
  const DIRECT_STALL_MS = 25000;

  const autoFallbackAllowed = () => Boolean(appSettings.state?.uploads?.chunkedAutoFallback);
  const readFallbackMiB = getUploadFallbackMiB;
  const writeFallbackMiB = (mib) => {
    try {
      localStorage.setItem(UPLOAD_FALLBACK_STORAGE_KEY, String(mib));
    } catch (_) {
      /* noop */
    }
  };
  const clearFallbackMiB = resetUploadFallback;

  const getUploadSettings = () => {
    const adminChunked = Boolean(appSettings.state?.uploads?.chunkedEnabled);
    const adminChunkBytes = Number.isFinite(appSettings.state?.uploads?.chunkSizeBytes)
      ? appSettings.state.uploads.chunkSizeBytes
      : 8 * MIB_BYTES;
    if (adminChunked) {
      return { chunkedEnabled: true, chunkSizeBytes: adminChunkBytes };
    }
    // Direct (XHR) mode: if a previous direct upload on this origin was rejected
    // by a proxy, use chunked with the remembered size instead.
    const fallbackMiB = autoFallbackAllowed() ? readFallbackMiB() : null;
    if (fallbackMiB) {
      return { chunkedEnabled: true, chunkSizeBytes: fallbackMiB * MIB_BYTES };
    }
    return { chunkedEnabled: false, chunkSizeBytes: adminChunkBytes };
  };

  const removeUploadPlugin = (id) => {
    const plugin = uppy?.getPlugin?.(id);
    if (plugin) {
      uppy.removePlugin(plugin);
    }
  };

  const removeCompletedUploadFiles = () => {
    const currentFiles = typeof uppy?.getFiles === 'function' ? uppy.getFiles() : [];
    currentFiles.forEach((file) => {
      if (!file?.id || file?.progress?.uploadComplete !== true) return;
      try {
        uppy.removeFile(file.id);
      } catch (_) {
        /* noop */
      }
    });
  };

  const removeUploadFile = (file) => {
    if (!file?.id) return;
    try {
      uppy.removeFile(file.id);
    } catch (_) {
      /* noop */
    }
  };

  const getTusErrorStatus = (error) => {
    if (typeof error?.originalResponse?.getStatus === 'function') {
      return error.originalResponse.getStatus();
    }
    return null;
  };

  const isNetworkUploadError = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return (
      error instanceof TypeError ||
      message.includes('network error') ||
      message.includes('failed to fetch') ||
      message.includes('load failed') ||
      message.includes('networkerror') ||
      message.includes('unexpected response while uploading chunk') ||
      message.includes('unexpected response while creating upload')
    );
  };

  const configureUploadPlugin = () => {
    if (!uppy) return;

    const uploadSettings = getUploadSettings();
    const nextMode = uploadSettings.chunkedEnabled ? 'tus' : 'xhr';

    if (uploadPluginMode === nextMode) {
      if (nextMode === 'tus') {
        uppy.getPlugin('Tus')?.setOptions?.({
          chunkSize: uploadSettings.chunkSizeBytes,
        });
      }
      return;
    }

    removeUploadPlugin('XHRUpload');
    removeUploadPlugin('Tus');

    if (nextMode === 'tus') {
      uppy.use(Tus, {
        endpoint: `${apiBase}/api/upload/tus`,
        chunkSize: uploadSettings.chunkSizeBytes,
        allowedMetaFields: ['name', 'type', 'uploadTo', 'relativePath'],
        removeFingerprintOnSuccess: true,
        storeFingerprintForResuming: false,
        // Resume a dropped chunk a few times before giving up. The browser File is
        // disk-backed and @tus/server resumes from the last stored offset, so a
        // retry re-sends only the unacknowledged bytes — not the whole file, and
        // nothing is held in memory. Without this a single transient drop
        // ("server connection was lost") kills a whole large-chunk upload.
        retryDelays: [0, 1000, 3000, 5000, 10000],
        onShouldRetry: (error, _retryAttempt, _options, next) => {
          const status = getTusErrorStatus(error);
          if (status === 507) return false; // storage full — retrying won't help
          if (status && status >= 400 && status < 500) return false; // auth / permission / too large
          if (isNetworkUploadError(error)) return true; // transient drop — resume from the offset
          return next(error);
        },
        withCredentials: true,
      });
    } else {
      uppy.use(XHRUpload, {
        endpoint: `${apiBase}/api/upload`,
        formData: true,
        fieldName: 'filedata',
        bundle: false,
        responseType: 'json',
        // Uppy v5 expects `allowedMetaFields` to be `true` (all) or an explicit list.
        // `null` results in *no* metadata being sent, which breaks `uploadTo`/`relativePath`.
        allowedMetaFields: true,
        withCredentials: true,
      });
    }

    uploadPluginMode = nextMode;
  };

  // True while uploads currently go out directly (XHR) — i.e. auto-fallback is on,
  // forced chunking is off, and no per-origin fallback size has been learned yet.
  const directModeActive = () => autoFallbackAllowed() && !getUploadSettings().chunkedEnabled;

  // Restart a file as a FRESH chunked upload (identical to the working manual
  // chunked path — a mid-flight plugin swap + retryUpload proved unreliable),
  // stepping the chunk size down the ladder. Clears the fallback (→ back to
  // direct) if even the smallest chunk fails, so a non-size failure doesn't stick.
  const restarting = new Set();
  const performFallbackRestart = (file, observedBytes) => {
    if (!file?.id || restarting.has(file.id)) return true;

    const currentFallback = readFallbackMiB();
    let nextMiB;
    if (!currentFallback) {
      // First fallback: pick the largest ladder size below where the direct
      // upload got cut off (a hint at the proxy limit), else the largest.
      const observedMiB = observedBytes > 0 ? Math.floor(observedBytes / MIB_BYTES) : Infinity;
      nextMiB = FALLBACK_LADDER_MIB.find((size) => size < observedMiB) ?? FALLBACK_LADDER_MIB[0];
    } else {
      const idx = FALLBACK_LADDER_MIB.indexOf(currentFallback);
      nextMiB =
        idx >= 0 && idx + 1 < FALLBACK_LADDER_MIB.length ? FALLBACK_LADDER_MIB[idx + 1] : null;
    }
    if (!nextMiB) {
      clearFallbackMiB();
      return false;
    }

    restarting.add(file.id);
    writeFallbackMiB(nextMiB);
    const descriptor = {
      name: file.name,
      type: file.type,
      data: file.data,
      meta: file.meta ? { ...file.meta } : {},
    };
    setTimeout(() => {
      try {
        uppy.removeFile(file.id);
        configureUploadPlugin(); // now chunked (TUS) with the new size
        uppy.addFile(descriptor); // autoProceed re-uploads via TUS
      } catch (err) {
        console.error('Auto-fallback restart failed', err);
      }
    }, 0);
    return true;
  };

  // Error path: any failure of a large direct upload (proxy 413, network drop,
  // timeout) → chunked. Skip errors chunking can't fix (auth / storage full).
  const maybeAutoFallback = (file, error, response) => {
    if (!directModeActive() || !file?.data) return false;
    if ((Number(file?.size) || 0) <= 8 * MIB_BYTES) return false;
    const status = getTusErrorStatus(error) ?? response?.status ?? null;
    if (status === 401 || status === 403 || status === 507) return false;
    return performFallbackRestart(file, Number(file?.progress?.bytesUploaded) || 0);
  };

  // Stall path: a proxy that silently stops reading an over-limit body never
  // errors, so a watchdog trips the same fallback when a direct upload freezes.
  const progressAt = new Map(); // fileId -> { bytes, at }
  let watchdogTimer = null;
  const stopWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    progressAt.clear();
    restarting.clear();
  };
  const startWatchdog = () => {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      const files = typeof uppy?.getFiles === 'function' ? uppy.getFiles() : [];
      if (files.length === 0) {
        stopWatchdog();
        return;
      }
      if (!directModeActive()) return;
      const now = Date.now();
      for (const f of files) {
        if (f?.progress?.uploadComplete || (Number(f?.size) || 0) <= 8 * MIB_BYTES) continue;
        const tracked = progressAt.get(f.id);
        if (tracked && tracked.bytes > 0 && now - tracked.at > DIRECT_STALL_MS) {
          progressAt.delete(f.id);
          if (performFallbackRestart(f, tracked.bytes)) break;
        }
      }
    }, 5000);
  };
  const trackProgress = (file, progress) => {
    const bytes = Number(progress?.bytesUploaded) || 0;
    const prev = progressAt.get(file.id);
    // Only advance the timestamp when bytes actually grow, so a freeze is caught.
    if (!prev || bytes > prev.bytes) progressAt.set(file.id, { bytes, at: Date.now() });
    if (directModeActive()) startWatchdog();
  };

  if (!uppy) {
    uppy = new Uppy({
      debug: import.meta.env.DEV,
      autoProceed: true,
      store: uppyStore,
    });

    configureUploadPlugin();

    // Cookies carry auth; no token headers
    uppy.on('file-added', (file) => {
      if (!canUploadToCurrentPath()) {
        uppy.removeFile?.(file.id);
        notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
        return;
      }

      if (isDisallowedUpload(file?.name)) {
        uppy.removeFile?.(file.id);
        return;
      }

      // Ensure server always receives a usable relativePath, even for drag-and-drop
      const inferredRelativePath =
        file?.meta?.relativePath ||
        file?.data?.webkitRelativePath ||
        file?.name ||
        (file?.data && file?.data.name) ||
        '';

      // Some rare DnD sources may miss name; prefer data.name if present
      if (!file?.name && file?.data?.name && typeof uppy.setFileName === 'function') {
        try {
          uppy.setFileName(file.id, file.data.name);
        } catch (_) {
          /* noop */
        }
      }

      uppy.setFileMeta(file.id, {
        uploadTo: normalizePath(fileStore.currentPath || ''),
        relativePath: inferredRelativePath,
      });
    });

    uppy.on('upload', (_uploadID, batchFiles) => {
      // Safety net: if permissions changed after files were queued, cancel *only* when the
      // batch is targeting the currently-viewed path (avoids canceling uploads after navigation).
      const current = normalizePath(fileStore.currentPath || '');
      const files = Array.isArray(batchFiles) ? batchFiles : [];
      const targetsCurrentPath =
        files.length > 0 && files.every((f) => normalizePath(f?.meta?.uploadTo || '') === current);

      if (!targetsCurrentPath) return;
      if (canUploadToCurrentPath()) return;

      try {
        uppy.cancelAll?.();
      } catch (_) {
        /* noop */
      }
      notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
    });

    uppy.on('upload-progress', trackProgress);

    uppy.on('upload-success', () => {
      fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
    });

    uppy.on('complete', (result) => {
      stopWatchdog();
      const successfulFiles = Array.isArray(result?.successful) ? result.successful : [];
      const failedFiles = Array.isArray(result?.failed) ? result.failed : [];
      [...successfulFiles, ...failedFiles].forEach(removeUploadFile);
    });

    uppy.on('upload-error', (file, error, response) => {
      // A proxy body-size rejection on a direct upload: switch this origin to
      // chunked and retry instead of surfacing the error.
      if (maybeAutoFallback(file, error, response)) return;

      const body = response?.body;
      const nested = body && typeof body === 'object' ? body?.error : null;
      const nestedObj = nested && typeof nested === 'object' ? nested : null;
      const networkError = isNetworkUploadError(error);

      const rawHeading =
        nestedObj?.message ||
        (typeof nested === 'string' ? nested : '') ||
        error?.message ||
        'Upload failed';
      const heading = networkError
        ? 'Upload interrupted because the server connection was lost.'
        : rawHeading;
      const bodyText = networkError
        ? 'The transfer was stopped. Check the network connection and retry the upload.'
        : nestedObj?.details !== undefined && nestedObj?.details !== null
          ? JSON.stringify(nestedObj.details)
          : '';

      notifyErrorOnce(heading, {
        body: bodyText,
        requestId: nestedObj?.requestId || null,
        statusCode: nestedObj?.statusCode ?? response?.status,
        dedupeKey: `upload-error:${heading}`,
        dedupeMs: 15000,
      });
      setTimeout(() => removeUploadFile(file), 0);
      // Keep UI in sync in case some files partially uploaded.
      if (fileStore.currentPath) {
        fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
      }
    });

    uppy.on('error', (error) => {
      const message = isNetworkUploadError(error)
        ? 'Upload interrupted because the server connection was lost.'
        : error?.message || 'Upload error';
      notifyErrorOnce(message, {
        dedupeKey: `uppy-error:${message}`,
        dedupeMs: 15000,
      });
    });

    // Uppy v5 uses private class fields; if it gets wrapped in a Vue Proxy (reactive store),
    // method calls will throw "Cannot read from private field". Keep it raw.
    uppyStore.uppy = markRaw(uppy);
    createdHere.value = true;
  }

  function uppyFile(file) {
    return {
      name: file.name,
      type: file.type,
      data: file,
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
      notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
      return Promise.resolve();
    }

    try {
      await appSettings.ensureLoaded();
    } catch (_) {
      // Keep upload available with safe defaults if settings cannot be loaded.
    }
    configureUploadPlugin();

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

      inputRef.value.onchange = (e) => {
        removeCompletedUploadFiles();

        const selectedFiles = Array.from(e.target.files || []).filter(
          (file) => !isDisallowedUpload(file.name)
        );

        files.value = selectedFiles.map((file) => uppyFile(file));
        files.value.forEach((file) => uppy.addFile(file));

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

    appSettings
      .ensureLoaded()
      .catch(() => {})
      .finally(() => configureUploadPlugin());
  });

  onBeforeUnmount(() => {
    inputRef.value?.remove();
    // Only close the singleton if we created it here
    if (createdHere.value) {
      // Uppy v5 uses `destroy()`. Older versions had `close()` in some setups.
      uppy.destroy?.();
      uppy.close?.();
      if (uppyStore.uppy === uppy) {
        uppyStore.uppy = null;
      }
    }
  });

  return {
    files,
    openDialog,
  };
}

// Attach/detach Uppy DropTarget plugin to a given element ref
export function useUppyDropTarget(targetRef) {
  const uppyStore = useUppyStore();

  onMounted(() => {
    const el = targetRef && 'value' in targetRef ? targetRef.value : null;
    const uppy = uppyStore.uppy;
    if (el && uppy) {
      try {
        const existing = uppy.getPlugin && uppy.getPlugin('DropTarget');
        if (existing) uppy.removePlugin(existing);
        uppy.use(DropTarget, { target: el });
      } catch (_) {
        // ignore if plugin cannot be mounted
      }
    }
  });

  onBeforeUnmount(() => {
    const uppy = uppyStore.uppy;
    if (uppy) {
      const plugin = uppy.getPlugin && uppy.getPlugin('DropTarget');
      if (plugin) uppy.removePlugin(plugin);
    }
  });
}
