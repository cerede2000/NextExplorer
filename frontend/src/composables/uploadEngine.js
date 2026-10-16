import { markRaw } from 'vue';
import Uppy from '@uppy/core';
import XHRUpload from '@uppy/xhr-upload';
import Tus from '@uppy/tus';
import { useUppyStore } from '@/stores/uppyStore';
import { useFileStore } from '@/stores/fileStore';
import { useFeaturesStore } from '@/stores/features';
import { useNotificationsStore } from '@/stores/notifications';
import { useAppSettings } from '@/stores/appSettings';
import { useVolumeUsageStore } from '@/stores/volumeUsage';
import { useFolderSizeStore } from '@/stores/folderSize';
import { useOperationTasksStore } from '@/stores/operationTasks';
import { apiBase, normalizePath, reserveFolderUploadTarget } from '@/api';
import { shareScoped } from '@/api/shareScope';
import {
  directUploadEndpoint,
  folderUploadParts,
  uploadPermission,
  uploadBlockedMessage,
} from './uploadTarget';
import { isDisallowedUpload } from '@/utils/uploads';
// The fallback ladder lives in utils so it can be tested without Uppy, a Pinia
// store and a browser around it.
import { nextFallbackMiB } from '@/utils/uploadFallback';
// So is the mode decision, for the same reason.
import {
  isInFallbackChunked,
  isLargeUpload,
  isWatchingDirectUploads,
  resolveUploadMode,
} from '@/utils/uploadMode';
import {
  createErrorNotifier,
  createUploadBatchId,
  getUploadFallbackMiB,
  resetUploadFallback,
  writeUploadFallbackMiB,
} from './uploadCommon';

/**
 * The part of uploading that is Uppy: the instance, its two uploaders, and
 * every decision taken on its events.
 *
 * Loaded when an upload is about to happen — a picker opened, a file dragged
 * over the page — rather than with the page, which is what it was: a few
 * hundred kilobytes on every first load for something most visits never do.
 * `fileUploader.js` asks for it, once, and hands it files only after this
 * has returned, so nothing reaches the network before every handler below is
 * in place: the reservation of a dropped folder's name, the choice between a
 * direct upload and TUS, the watchdog on a stalled one.
 *
 * One instance for the application, as before. It is torn down by whoever
 * owns the uploads — the layout — and not by the dialog that happened to ask
 * for it first.
 */
export const createUploadEngine = async () => {
  const uppyStore = useUppyStore();
  const fileStore = useFileStore();
  const notificationsStore = useNotificationsStore();
  const appSettings = useAppSettings();
  const volumeUsageStore = useVolumeUsageStore();
  const folderSizeStore = useFolderSizeStore();
  const operationTasksStore = useOperationTasksStore();
  const folderReservationByBatch = new Map();
  const notifyErrorOnce = createErrorNotifier(notificationsStore);

  let uppy = null;
  let uploadPluginMode = null;
  let uploadViewRefreshTimer = null;

  // Multer starts the file storage callback as soon as it receives the binary
  // part. Multipart metadata can legally arrive afterwards, so keep routing
  // data in the request URL where Express has it before the stream is opened.
  const reserveFolderUploadPaths = async (fileIDs) => {
    const groups = new Map();

    (Array.isArray(fileIDs) ? fileIDs : []).forEach((fileId) => {
      const file = uppy?.getFile?.(fileId);
      const parts = folderUploadParts(file);
      if (!file || !parts || file.meta?.resolvedRelativePath) return;

      const uploadTo = normalizePath(file.meta?.uploadTo || fileStore.currentPath || '');
      const uploadBatchId = file.meta?.uploadBatchId || createUploadBatchId();
      const key = `${uploadTo}\u0000${uploadBatchId}\u0000${parts[0]}`;
      if (!groups.has(key))
        groups.set(key, { uploadTo, uploadBatchId, sourceRoot: parts[0], files: [] });
      groups.get(key).files.push({ file, parts });
    });

    for (const [key, group] of groups) {
      let reservation = folderReservationByBatch.get(key);
      if (!reservation) {
        reservation = reserveFolderUploadTarget(group.uploadTo, group.sourceRoot);
        folderReservationByBatch.set(key, reservation);
      }

      const response = await reservation;
      const targetRoot = response?.targetRoot;
      if (!targetRoot) throw new Error('The server did not reserve a destination folder.');

      group.files.forEach(({ file, parts }) => {
        uppy.setFileMeta(file.id, {
          ...(file.meta || {}),
          uploadBatchId: group.uploadBatchId,
          resolvedRelativePath: [targetRoot, ...parts.slice(1)].join('/'),
        });
      });
    }
  };

  const releaseFolderReservations = (batchFiles = []) => {
    (Array.isArray(batchFiles) ? batchFiles : []).forEach((file) => {
      const parts = folderUploadParts(file);
      const uploadTo = normalizePath(file?.meta?.uploadTo || '');
      const uploadBatchId = file?.meta?.uploadBatchId;
      if (!parts || !uploadBatchId) return;
      folderReservationByBatch.delete(`${uploadTo}\u0000${uploadBatchId}\u0000${parts[0]}`);
    });
  };

  // A folder upload emits one success event per file. Wait for a short quiet
  // period so those events produce one listing refresh instead of repeatedly
  // aborting the preceding browse request.
  //
  // `refresh` rather than a fetch of the same path: this is the folder already on
  // screen being read again, not somebody walking into it. A fetch clears what is
  // selected, and this one lands the better part of a second after the upload —
  // long enough for the reader to have chosen a file in the meantime and watched
  // the choice disappear under them.
  const scheduleUploadViewRefresh = (delayMs = 700) => {
    if (uploadViewRefreshTimer) clearTimeout(uploadViewRefreshTimer);
    uploadViewRefreshTimer = setTimeout(() => {
      uploadViewRefreshTimer = null;
      fileStore.refresh().catch(() => {});
      volumeUsageStore.scheduleRefresh();
      folderSizeStore.scheduleRefresh();
    }, delayMs);
  };

  /** The decision and its reason together, from one rule rather than two. */
  const currentUploadPermission = () =>
    uploadPermission(fileStore.currentPathData, fileStore.currentPath);

  const canUploadToCurrentPath = () => currentUploadPermission().allowed;

  const blockedMessage = () => uploadBlockedMessage(currentUploadPermission().reason);

  // Chunk sizes tried on fallback (largest first, near the value that works
  // manually). Each PATCH stays well under a typical reverse-proxy body limit.
  // A direct upload that makes no progress for this long is treated as stalled.
  // A reverse proxy that silently stops reading an over-limit body never errors,
  // so a stall is the only signal we get for that case. Also used as the XHR
  // progress-timeout so Uppy emits `upload-stalled` on the same deadline.
  const DIRECT_STALL_MS = 20000;

  const readFallbackMiB = getUploadFallbackMiB;
  const writeFallbackMiB = writeUploadFallbackMiB;
  const clearFallbackMiB = resetUploadFallback;

  /**
   * The upload policy in force, wherever it can be read from.
   *
   * An account reads it in its settings; somebody holding a share link has no
   * account and reads it in the feature flags, which every page is given. The
   * policy is the installation's either way — forced chunks, the fallback, the
   * chunk size — so the two agree, and the one who cannot read the first must
   * not be left on the defaults: those say "go direct and never fall back",
   * which turns a file too big for one request into a refusal nothing recovers
   * from. That is what a shared folder for uploads did to anything large.
   */
  const uploadPolicy = () => {
    if (appSettings.loaded && appSettings.state?.uploads) return appSettings.state.uploads;
    // Asked for only when there is nothing else to read it from: reaching for
    // the store to find out would build it wherever an uploader is made.
    try {
      return useFeaturesStore().uploadPolicy || {};
    } catch (_) {
      return {};
    }
  };

  const getUploadSettings = () => resolveUploadMode(uploadPolicy(), readFallbackMiB());

  // Auto-fallback modes (auto on, admin hasn't force-enabled chunking):
  //  - "direct":  no size learned yet  → uploads go out as a single XHR
  //  - "chunked": a size is remembered → uploads go through TUS
  const inDirectMode = () => isWatchingDirectUploads(uploadPolicy(), readFallbackMiB());
  const inFallbackChunkedMode = () => isInFallbackChunked(uploadPolicy(), readFallbackMiB());
  const isLargeFile = isLargeUpload;

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
      removeUploadFile(file);
    });
  };

  /**
   * One operation for a batch, not one for every file in it.
   *
   * A reader who drops a folder has asked for one thing. Starting an operation
   * per file made one reactive entry and one drawn row per file, with nothing
   * capping the list — measured at four gigabytes across a few thousand files,
   * which is where the tab stopped responding. The register already carries
   * `itemCount` and `totalBytes` for exactly this, and a single file is simply a
   * batch of one, so the common case looks as it always did.
   *
   * The batch is started from `files-added`, which Uppy emits once with the
   * whole batch, rather than from `file-added`: counting up as each file
   * arrives would be the same storm of updates under another name.
   */
  const batches = new Map();
  const batchOf = new Map();
  /** Files a guard turned away, so the batch does not count them. */
  const refusedFiles = new Set();

  const batchFor = (fileId) => batches.get(batchOf.get(fileId));

  /** The folder a whole batch came out of, when it came out of one. */
  const sharedFolder = (files) => {
    const roots = new Set(
      files.map((file) => String(file?.meta?.relativePath || '').split('/')[0] || '')
    );
    const [only] = [...roots];
    return roots.size === 1 && only ? only : '';
  };

  const finishUploadTask = (fileId) => {
    const batchId = batchOf.get(fileId);
    if (batchId === undefined) return;
    batchOf.delete(fileId);
    const batch = batches.get(batchId);
    if (!batch) return;
    batch.fileIds.delete(fileId);
    batch.sentByFile.delete(fileId);
    batch.totalByFile.delete(fileId);
    // The operation ends when the last of its files does, not the first.
    if (batch.fileIds.size > 0) return;
    batches.delete(batchId);
    if (batches.size === 0) stopWatchingFinalization();
    operationTasksStore.finishOperation(batch.operationId);
  };

  const removeUploadFile = (file) => {
    if (!file?.id) return;
    finishUploadTask(file.id);
    relativePathAtAdd.delete(file.id);
    try {
      uppy.removeFile(file.id);
    } catch (_) {
      /* noop */
    }
  };

  const openOrExtendBatch = (addedFiles, destination) => {
    const files = (Array.isArray(addedFiles) ? addedFiles : []).filter(
      (file) => file?.id && !refusedFiles.has(file.id) && batchOf.get(file.id) === undefined
    );
    if (!files.length) return;

    const batchId = files[0]?.meta?.uploadBatchId || createUploadBatchId();

    // A drop is added in slices, so the batch is opened by the first slice and
    // grows with the rest — one update to the operation per slice rather than
    // one per file.
    const open = batches.get(batchId);
    if (open) {
      files.forEach((file) => {
        open.fileIds.add(file.id);
        open.totalByFile.set(file.id, Number(file.size) || 0);
        open.totalBytes += Number(file.size) || 0;
        open.added += 1;
        batchOf.set(file.id, batchId);
      });
      operationTasksStore.updateOperation(open.operationId, {
        itemCount: open.added,
        totalBytes: open.totalBytes,
      });
      return;
    }

    const fileIds = new Set(files.map((file) => file.id));
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const folder = sharedFolder(files);
    const operationId = operationTasksStore.startOperation({
      type: 'upload',
      // One file is named; a folder is named for the folder; anything else is
      // counted, which the panel does from `itemCount` on its own.
      name: files.length === 1 ? files[0].name || files[0].data?.name || '' : folder,
      destination,
      itemCount: files.length,
      totalBytes,
      copiedBytes: 0,
      cancellable: true,
      cancel: () => {
        [...fileIds].forEach((id) => removeUploadFile(uppy?.getFile?.(id) || { id }));
        scheduleUploadViewRefresh(100);
      },
      // A chunked upload can be held and picked up again: the bytes already sent
      // stay sent. A direct one cannot — there is nothing to pick up from — so it
      // is not offered. A file that falls back to chunks is added again under a
      // new id, and the batch it starts then says so on its own.
      pausable: uploadPluginMode === 'tus',
      pause: () => fileIds.forEach((id) => uppy.pauseResume(id)),
      resume: () => fileIds.forEach((id) => uppy.pauseResume(id)),
    });
    batches.set(batchId, {
      operationId,
      fileIds,
      // How many have ever been in it, which is what the panel counts: files
      // leave `fileIds` as they finish, and a count that shrank would read as
      // the batch getting smaller.
      added: files.length,
      // The sizes declared when the files were added, and the sum of them. The
      // uploader reports a total of its own per file as it goes, which is the
      // one that counts: a declared size can be absent or wrong, and the bar
      // has to agree with what is actually being sent.
      totalByFile: new Map(files.map((file) => [file.id, Number(file.size) || 0])),
      totalBytes,
      sent: 0,
      sentByFile: new Map(),
    });
    fileIds.forEach((id) => batchOf.set(id, batchId));
  };

  const updateUploadTask = (file, progress) => {
    const batch = batchFor(file?.id);
    if (!batch) return;
    const fileTotal = Number(progress?.bytesTotal) || Number(file?.size) || 0;
    const sent = Math.min(Number(progress?.bytesUploaded) || 0, fileTotal || Infinity);
    const totalBefore = batch.totalByFile.get(file.id) || 0;
    const before = batch.sentByFile.get(file.id) || 0;
    // A progress event that moved nothing writes nothing: the uploader reports
    // often, and every write here is a notification to everything watching.
    if (sent === before && fileTotal === totalBefore) return;
    batch.totalByFile.set(file.id, fileTotal);
    batch.totalBytes += fileTotal - totalBefore;
    batch.sentByFile.set(file.id, sent);
    batch.sent += sent - before;
    operationTasksStore.updateOperation(batch.operationId, {
      totalBytes: batch.totalBytes,
      copiedBytes: Math.min(batch.sent, batch.totalBytes || Number.POSITIVE_INFINITY),
    });

    // Every byte is out, but the server may still be writing the files where
    // they belong — a copy, whenever the upload cache and the destination volume
    // are separate filesystems. Nothing more will arrive on a progress event, so
    // from here the server is the only one who knows how far along it is.
    if (batch.totalBytes > 0 && batch.sent >= batch.totalBytes) watchFinalization();
  };

  // Ask only while something is waiting on it, and stop as soon as the server
  // has nothing left to report.
  const FINALIZATION_POLL_MS = 750;
  let finalizationTimer = null;

  const stopWatchingFinalization = () => {
    if (finalizationTimer) clearTimeout(finalizationTimer);
    finalizationTimer = null;
  };

  const applyFinalization = (items) => {
    const byName = new Map(items.map((item) => [item.name, item]));

    // Added up over the batch, because the batch is what is drawn: one bar for
    // what the server still has to write, not one per file.
    batches.forEach((batch) => {
      let finalizedBytes = 0;
      let finalizedTotalBytes = 0;
      let answered = false;
      batch.fileIds.forEach((fileId) => {
        const item = byName.get(uppy?.getFile?.(fileId)?.name || '');
        if (!item) return;
        answered = true;
        finalizedBytes += Number(item.copiedBytes) || 0;
        finalizedTotalBytes += Number(item.totalBytes) || 0;
      });
      if (!answered) return;
      operationTasksStore.updateOperation(batch.operationId, {
        finalizing: true,
        finalizedBytes,
        finalizedTotalBytes,
      });
    });
  };

  const watchFinalization = () => {
    if (finalizationTimer || batches.size === 0) return;

    finalizationTimer = setTimeout(async () => {
      finalizationTimer = null;
      if (batches.size === 0) return;

      let items = [];
      try {
        const response = await fetch(
          `${apiBase}${shareScoped('/api/upload/finalizations', normalizePath(fileStore.currentPath || ''))}`,
          { credentials: 'include' }
        );
        if (response.ok) items = (await response.json())?.items || [];
      } catch (_) {
        // A dropped poll says nothing about the upload itself; try again.
      }

      applyFinalization(Array.isArray(items) ? items : []);
      if (batches.size > 0) watchFinalization();
    }, FINALIZATION_POLL_MS);
  };

  const getTusErrorStatus = (error) => {
    if (typeof error?.originalResponse?.getStatus === 'function') {
      return error.originalResponse.getStatus();
    }
    return null;
  };

  /**
   * The reason the server gave when every byte arrived but the file could not
   * be put in its folder, or '' when it gave none.
   *
   * Nothing is gained by trying again. A retry asks for the offset first, the
   * offset is complete, and before the server said otherwise the client took
   * that as an upload that had succeeded; falling back to smaller chunks would
   * send the whole file again into the same failure.
   */
  const getFinalizeError = (error) => {
    const raw = error?.originalResponse?.getHeader?.('Upload-Finalize-Error');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return String(raw);
    }
  };

  const isNetworkUploadError = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return (
      error instanceof TypeError ||
      message.includes('network error') ||
      message.includes('failed to fetch') ||
      // Safari's fetch says "Load failed" where Chrome says "Failed to fetch",
      // and tus-js-client quotes it inside its own message. Anchored on a word
      // boundary because a plain "Upload failed" is not a network diagnosis:
      // matching it would replace whatever the server said with a sentence
      // about the connection.
      /(?:^|[^a-z])load failed/.test(message) ||
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
        // Under the share's prefix when the folder being filled is inside one.
        // The resumable uploader holds a single endpoint for every file, and it
        // is set in two places: here, when the plugin is put in, and again as
        // each file is queued. Only the second one was scoped, which left the
        // first pointing at the application's own address — and inside a share
        // that address belongs to nobody the visitor can be. It is reached
        // exactly when the automatic switch to chunked happens, which is the
        // one thing a visitor needs for a file too big to go in one piece: the
        // direct attempt is refused for its size, the fallback rebuilds the
        // plugin through here, and the first chunk went somewhere an
        // authentication proxy answers instead of this server.
        endpoint: `${apiBase}${shareScoped('/api/upload/tus', normalizePath(fileStore.currentPath || ''))}`,
        chunkSize: uploadSettings.chunkSizeBytes,
        allowedMetaFields: [
          'name',
          'type',
          'uploadTo',
          'relativePath',
          'resolvedRelativePath',
          'uploadBatchId',
          // When the file was last changed, which is what tells one file from
          // another of the same name and size — so what the server keeps of an
          // unfinished upload can say which file it was waiting for.
          'lastModified',
        ],
        removeFingerprintOnSuccess: true,
        /**
         * Remember where an upload got to, so the same file continues instead of
         * starting again.
         *
         * The bytes are in the browser: an upload cannot carry on by itself when
         * the tab goes away, the way a copy in the server does. What it can do is
         * come back to where it stopped — the server keeps the part that arrived
         * for a day — and that needs the address of the upload to survive the
         * page, which is what this stores. Without it a reader who lost their
         * connection at ninety per cent sent the whole file again.
         *
         * Safe because the fingerprint tells the destination apart: see the
         * per-file endpoint in `file-added`. A fingerprint that did not would
         * resume an upload bound for another folder, and the file would land
         * where it was never sent.
         */
        storeFingerprintForResuming: true,
        // Resume a dropped chunk a few times before giving up. The browser File is
        // disk-backed and @tus/server resumes from the last stored offset, so a
        // retry re-sends only the unacknowledged bytes — not the whole file, and
        // nothing is held in memory. Without this a single transient drop
        // ("server connection was lost") kills a whole large-chunk upload.
        retryDelays: [0, 1000, 3000, 5000, 10000],
        onShouldRetry: (error, _retryAttempt, _options, next) => {
          if (getFinalizeError(error)) return false; // received, but not placed — see above
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
        endpoint: directUploadEndpoint,
        formData: true,
        fieldName: 'filedata',
        bundle: false,
        responseType: 'json',
        // Uppy v5 expects `allowedMetaFields` to be `true` (all) or an explicit list.
        // `null` results in *no* metadata being sent, which breaks `uploadTo`/`relativePath`.
        allowedMetaFields: true,
        withCredentials: true,
        // Uppy's fetcher retries a failed request up to 3x by default, re-sending
        // the ENTIRE (possibly multi-GB) body each time. Against a proxy body-size
        // limit that just repeats a doomed upload and buries the chunked fallback
        // behind minutes of re-uploading. Fail on the FIRST error so auto-fallback
        // can switch to TUS immediately (TUS is our resilience mechanism, and it
        // resumes from the last stored offset rather than re-sending the file).
        shouldRetry: () => false,
        // Emit `upload-stalled` after this long with no progress, so a silently
        // stalled body (proxy stopped reading, no error) is caught quickly.
        timeout: DIRECT_STALL_MS,
      });
    }

    uploadPluginMode = nextMode;
  };

  // Pick the next chunk size to try. First fallback (no size learned yet): the
  // largest ladder step below where the direct upload got cut off (a hint at the
  // proxy limit), else the largest. Otherwise step down to the next smaller size.
  const nextLadderMiB = (observedBytes) => nextFallbackMiB(readFallbackMiB(), observedBytes);

  // Restart a file as a FRESH chunked (TUS) upload — identical to the working
  // manual chunked path (a page load with chunking configured), which is why it
  // is reliable where a mid-flight plugin swap + retryUpload was not: the swap
  // happens while Uppy is idle (after the failed/stalled batch settles), then a
  // brand-new file is added and uploaded by the freshly-installed TUS plugin.
  // Returns true if a restart was scheduled (caller suppresses the error),
  // false if we exhausted the ladder and gave up.
  const restarting = new Set();

  /**
   * What `relativePath` each file carried when Uppy first saw it.
   *
   * Uppy builds a file's id out of its name, type, size, date and
   * `meta.relativePath`, and that id is what the resume fingerprint is made of.
   * `file-added` fills `relativePath` in for a file that arrived without one,
   * which is harmless there — the id was already decided. A file re-added by
   * the fallback is a *new* add, though, and re-adding it with the filled-in
   * field gives it an id the same file would never be given again: the first
   * attempt at a large file goes direct, is refused, and comes back here, while
   * the next attempt is chunked from the start and is added once. Two ids for
   * one file, and an interrupted upload that can never be resumed — which is
   * exactly the case resuming was built for. So the re-add is given what the
   * first add was given, and the field is put back afterwards.
   */
  const relativePathAtAdd = new Map();
  const restartAsChunked = (file, observedBytes) => {
    if (!file?.id) return false;
    if (restarting.has(file.id)) return true;

    const nextMiB = nextLadderMiB(observedBytes);
    if (!nextMiB) {
      // Even the smallest chunk failed → not a body-size problem. Revert to
      // direct so a future upload isn't stuck in chunked mode, and let the error
      // surface to the user.
      clearFallbackMiB();
      return false;
    }

    restarting.add(file.id);
    writeFallbackMiB(nextMiB);
    const originalMeta = file.meta ? { ...file.meta } : {};
    // The meta the id is computed from: what this file was added with, not what
    // it has been given since.
    const metaAsAdded = { ...originalMeta };
    const asAdded = relativePathAtAdd.get(file.id);
    if (asAdded === undefined) delete metaAsAdded.relativePath;
    else metaAsAdded.relativePath = asAdded;
    const descriptor = { name: file.name, type: file.type, data: file.data, meta: metaAsAdded };
    // Defer until Uppy has settled the current (failed/stalled) batch, so the
    // plugin swap runs on an idle instance — the reliable path.
    setTimeout(() => {
      try {
        removeUploadFile(file); // aborts the in-flight XHR if it is still hanging
        configureUploadPlugin(); // now TUS with the chosen chunk size
        const newId = uppy.addFile(descriptor); // autoProceed re-uploads via TUS
        // file-added rewrites uploadTo/relativePath from the current path; restore
        // the original target in case the user navigated during the upload.
        if (newId) uppy.setFileMeta(newId, originalMeta);
      } catch (err) {
        console.error('Auto-fallback restart failed', err);
        restarting.delete(file.id);
      }
    }, 0);
    return true;
  };

  // A large upload failed or stalled. Decide whether/how to fall back to chunks.
  //  - direct mode  → switch this origin to chunked (learn a size)
  //  - chunked mode → step the ladder down (the current size also failed)
  // Skip errors chunking can't fix (auth / permission / storage full).
  const handleUploadFailure = (file, status, observedBytes) => {
    if (!file?.data || !isLargeFile(file)) return false;
    if (status === 401 || status === 403 || status === 507) return false;
    if (inDirectMode() || inFallbackChunkedMode()) {
      return restartAsChunked(file, observedBytes);
    }
    return false;
  };

  // Stall watchdog: a proxy that silently stops reading an over-limit body never
  // errors, so a timer trips the fallback when a DIRECT upload freezes. Armed at
  // upload start (so even a 0-byte stall is caught) and cleared on `complete`.
  const progressAt = new Map(); // fileId -> { bytes, at }
  let watchdogTimer = null;
  const clearFallbackTracking = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    progressAt.clear();
    restarting.clear();
  };
  const startWatchdog = () => {
    if (watchdogTimer || !inDirectMode()) return;
    watchdogTimer = setInterval(() => {
      const list = typeof uppy?.getFiles === 'function' ? uppy.getFiles() : [];
      const active = list.filter((f) => !f?.progress?.uploadComplete && isLargeFile(f));
      // Nothing left to watch, or we've already switched to chunked — stop the
      // timer (a pending restart is already scheduled and guarded independently).
      if (active.length === 0 || !inDirectMode()) {
        clearFallbackTracking();
        return;
      }
      const now = Date.now();
      for (const f of active) {
        const tracked = progressAt.get(f.id);
        if (tracked && now - tracked.at > DIRECT_STALL_MS) {
          progressAt.delete(f.id);
          if (restartAsChunked(f, tracked.bytes)) break;
        }
      }
    }, 5000);
  };
  const trackProgress = (file, progress) => {
    const bytes = Number(progress?.bytesUploaded) || 0;
    const prev = progressAt.get(file.id);
    // Only advance the timestamp when bytes actually grow, so a freeze is caught.
    if (!prev || bytes > prev.bytes) progressAt.set(file.id, { bytes, at: Date.now() });
  };
  // Arm the watchdog when a direct-mode batch starts (seed each large file's
  // progress clock now, so a stall that never emits a progress event is caught).
  const armFallbackWatchdog = (batchFiles) => {
    if (!inDirectMode()) return;
    const now = Date.now();
    (Array.isArray(batchFiles) ? batchFiles : []).forEach((f) => {
      if (isLargeFile(f) && !progressAt.has(f.id)) progressAt.set(f.id, { bytes: 0, at: now });
    });
    startWatchdog();
  };

  uppy = new Uppy({
    debug: import.meta.env.DEV,
    autoProceed: true,
    store: uppyStore,
  });

  configureUploadPlugin();

  // DropTarget bypasses the native folder picker. Give every dropped folder
  // a common batch id, then reserve its destination in the preprocessor below
  // before XHRUpload or Tus is allowed to start sending bytes.
  uppy.on('files-added', (addedFiles) => {
    const files = Array.isArray(addedFiles) ? addedFiles : [];
    // A file added by some other path than ours — Uppy's own drop target, say —
    // arrives without the batch it belongs to. One batch for all of them, named
    // once rather than written onto each.
    const batchId =
      files.find((file) => file?.meta?.uploadBatchId)?.meta?.uploadBatchId || createUploadBatchId();
    files.forEach((file) => {
      if (folderUploadParts(file) && !file.meta?.uploadBatchId) {
        uppy.setFileMeta(file.id, { ...(file.meta || {}), uploadBatchId: batchId });
      }
    });
    const kept = files.filter((file) => file?.id && !refusedFiles.has(file.id));
    // The destination the batch was described with, not wherever the reader has
    // navigated to by the time this runs.
    openOrExtendBatch(
      kept,
      kept.find((file) => file?.meta?.uploadTo)?.meta?.uploadTo ??
        normalizePath(fileStore.currentPath || '')
    );
    aimFilesAtTheirFolder(kept);
  });

  uppy.addPreProcessor(reserveFolderUploadPaths);

  /**
   * The guards, and what they turn away — and nothing else.
   *
   * Everything this used to write per file is in the descriptor now: the
   * destination, the path inside a dropped folder, the date that tells two
   * files of the same name apart, and the uploader's address. Each of those was
   * a state update per file, and the address was a translator per file besides.
   * What is left is the two refusals, which have to be per file because they are
   * about the file, and the note of what the file's identity was computed from.
   */
  uppy.on('file-added', (file) => {
    if (!canUploadToCurrentPath()) {
      refusedFiles.add(file.id);
      uppy.removeFile?.(file.id);
      notifyErrorOnce(blockedMessage(), { durationMs: 5000 });
      return;
    }

    if (isDisallowedUpload(file?.name)) {
      refusedFiles.add(file.id);
      uppy.removeFile?.(file.id);
      return;
    }

    // Some rare sources may miss the name; prefer the file's own if present.
    if (!file?.name && file?.data?.name && typeof uppy.setFileName === 'function') {
      try {
        uppy.setFileName(file.id, file.data.name);
      } catch (_) {
        /* noop */
      }
    }

    // A file added by a path that did not describe it — Uppy's own drop target,
    // or a plugin — still needs the destination it is going to.
    if (!file?.meta?.uploadTo) {
      const uploadTo = normalizePath(fileStore.currentPath || '');
      uppy.setFileMeta(file.id, {
        ...(file.meta || {}),
        uploadTo,
        relativePath:
          file?.meta?.relativePath || file?.data?.webkitRelativePath || file?.name || '',
        resolvedRelativePath: file?.meta?.resolvedRelativePath || '',
        lastModified: String(file?.data?.lastModified ?? ''),
      });
    }

    // Before the field is filled in: what the id of this file was computed from.
    if (!relativePathAtAdd.has(file.id)) {
      relativePathAtAdd.set(file.id, file?.meta?.relativePath);
    }
  });

  /**
   * Every file in a slice pointed at its own folder, in one write.
   *
   * This has to be per file and cannot ride in the descriptor. tus-js-client
   * looks a previous upload up by a fingerprint Uppy builds as
   * `['tus', file.id, endpoint]`, and where a file is going travels in the
   * metadata, which the fingerprint never sees — so the same file sent to two
   * folders had one fingerprint between them, and the second would resume the
   * first. Aiming the plugin is not enough: a second batch to another folder
   * re-aims it while the first still has files waiting. And Uppy builds a file
   * from a fixed shape and drops the keys it does not know, `tus` among them,
   * which is checked in its `#transformFile`.
   *
   * So it is written — once for the whole slice. `setFileState` copies the
   * entire file map on every call, which makes a call per file quadratic:
   * measured against this Uppy, eight thousand files cost 17 seconds that way
   * and 13 milliseconds in one `patchFilesState`. The per-file call is kept as
   * the way back, because the batched one is not part of Uppy's documented
   * surface and an upload that cannot be resumed is worse than a slow one.
   *
   * Nothing reads this on the server — the destination is the metadata's, and
   * is authorized from there (`resolveTusUploadTarget`).
   */
  const aimFilesAtTheirFolder = (files) => {
    if (!files.length) return;
    const states = Object.fromEntries(
      files.map((file) => {
        const destination = file?.meta?.uploadTo ?? normalizePath(fileStore.currentPath || '');
        return [
          file.id,
          {
            tus: {
              ...(file.tus || {}),
              endpoint: `${apiBase}${shareScoped('/api/upload/tus', destination)}?for=${encodeURIComponent(destination)}`,
            },
          },
        ];
      })
    );
    if (typeof uppy.patchFilesState === 'function') {
      uppy.patchFilesState(states);
      return;
    }
    Object.entries(states).forEach(([id, state]) => uppy.setFileState(id, state));
  };

  uppy.on('upload', (_uploadID, batchFiles) => {
    const files = Array.isArray(batchFiles) ? batchFiles : [];

    // Safety net: if permissions changed after files were queued, cancel *only* when the
    // batch is targeting the currently-viewed path (avoids canceling uploads after navigation).
    const current = normalizePath(fileStore.currentPath || '');
    const targetsCurrentPath =
      files.length > 0 && files.every((f) => normalizePath(f?.meta?.uploadTo || '') === current);

    if (targetsCurrentPath && !canUploadToCurrentPath()) {
      try {
        uppy.cancelAll?.();
      } catch (_) {
        /* noop */
      }
      files.forEach((file) => finishUploadTask(file.id));
      notifyErrorOnce(blockedMessage(), { durationMs: 5000 });
      return;
    }

    // Uploads are proceeding — start the stall watchdog for direct-mode uploads.
    armFallbackWatchdog(files);
  });

  uppy.on('upload-progress', (file, progress) => {
    trackProgress(file, progress);
    updateUploadTask(file, progress);
  });

  // XHRUpload emits this after `timeout` ms with no progress — the only signal
  // for a body a proxy silently stopped reading. Switch to chunks immediately.
  uppy.on('upload-stalled', (_error, files) => {
    if (!inDirectMode()) return;
    (Array.isArray(files) ? files : []).forEach((file) => {
      if (isLargeFile(file)) {
        restartAsChunked(file, Number(file?.progress?.bytesUploaded) || 0);
      }
    });
  });

  uppy.on('upload-success', (file) => {
    finishUploadTask(file?.id);
    scheduleUploadViewRefresh();
  });

  uppy.on('complete', (result) => {
    clearFallbackTracking();
    const successfulFiles = Array.isArray(result?.successful) ? result.successful : [];
    const failedFiles = Array.isArray(result?.failed) ? result.failed : [];
    releaseFolderReservations([...successfulFiles, ...failedFiles]);
    [...successfulFiles, ...failedFiles].forEach(removeUploadFile);
    scheduleUploadViewRefresh(100);
  });

  uppy.on('cancel-all', () => folderReservationByBatch.clear());

  uppy.on('upload-error', (file, error, response) => {
    // A large direct upload that failed (proxy body-size rejection, network
    // drop, or a chunked attempt whose size still failed): fall back to chunks
    // / step the ladder down and retry instead of surfacing the error.
    const status = getTusErrorStatus(error) ?? response?.status ?? null;
    const finalizeError = getFinalizeError(error);
    if (
      !finalizeError &&
      handleUploadFailure(file, status, Number(file?.progress?.bytesUploaded) || 0)
    ) {
      return;
    }

    const body = response?.body;
    const nested = body && typeof body === 'object' ? body?.error : null;
    const nestedObj = nested && typeof nested === 'object' ? nested : null;
    // A failed PATCH reads like a dropped connection to the check below, and
    // the server's reason is the whole point here.
    const networkError = !finalizeError && isNetworkUploadError(error);

    const rawHeading =
      finalizeError ||
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
    scheduleUploadViewRefresh(100);
  });

  uppy.on('error', (error) => {
    // Uppy core re-emits every per-file `upload-error` here as a user-facing
    // "Failed to upload <name>" error (isUserFacing). Those are already owned by
    // our `upload-error` handler above — which stays SILENT when it auto-falls
    // back to chunks and only shows a toast on a genuine, final failure. So
    // skip them here to avoid a leaked toast during a (successful) fallback and
    // a duplicate toast on a real failure. Only surface generic (non-per-file)
    // Uppy errors.
    if (error?.isUserFacing) return;
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

  /**
   * Where this batch is going, with the uploader pointed at it once.
   *
   * This used to be done in `file-added`, per file, for an address that is the
   * same for every file in a batch: `setOptions` writes plugin state *and*
   * rebuilds the plugin's translator, so a thousand files meant a thousand
   * translators before a byte was sent.
   *
   * The query is what tells two uploads apart. tus-js-client looks a previous
   * upload up by a fingerprint Uppy builds as `['tus', file.id, endpoint]`, and
   * where a file is going travels in the metadata, which the fingerprint never
   * sees — so the same file sent to two folders had one fingerprint between
   * them, and the second would resume the first into a folder nobody sent it
   * to. Nothing reads it on the server: the destination is the metadata's and
   * is authorized from there (`resolveTusUploadTarget`).
   */
  const aimAtDestination = () => {
    const uploadTo = normalizePath(fileStore.currentPath || '');
    const endpoint = `${apiBase}${shareScoped('/api/upload/tus', uploadTo)}`;
    uppy
      .getPlugin('Tus')
      ?.setOptions?.({ endpoint: `${endpoint}?for=${encodeURIComponent(uploadTo)}` });
    return uploadTo;
  };

  /**
   * Everything a file needs, written where Uppy will keep it: in the descriptor.
   *
   * Set after the fact, each of these was another notification to everything
   * watching the uploader — `setFileState` and `setFileMeta`, per file. None of
   * it depends on Uppy having the file already.
   */
  const describeForUpload = ({ name, type, data, meta }, { uploadTo, batchId }) => ({
    name,
    type,
    data,
    meta: {
      ...(meta || {}),
      uploadTo,
      uploadBatchId: batchId,
      relativePath: meta?.relativePath || data?.webkitRelativePath || name || data?.name || '',
      // Uppy stringifies every field listed in `allowedMetaFields`, carried by
      // the file or not, so a field left unset reaches the server as the
      // literal "undefined". Only folder uploads fill this one in.
      resolvedRelativePath: meta?.resolvedRelativePath || '',
      // What tells this file from another of the same name and size.
      lastModified: String(data?.lastModified ?? ''),
    },
  });

  /**
   * Added in slices, with the main thread handed back between them.
   *
   * Uppy's own `addFiles` is quadratic in the number of files it is given: its
   * loop copies the whole file map once per file, unconditionally. Measured
   * against this version — two thousand files 0.5 s, four thousand 1.9 s, eight
   * thousand 9.5 s — which extrapolates to about a minute for the nineteen
   * thousand files of a project folder with its build output in it.
   *
   * Slicing does not reduce that total; nothing short of another uploader
   * would. What it does is stop it being one unbroken block: the page draws
   * between slices, the count climbs where the reader can see it, and the
   * operation can be cancelled while it is still going. A freeze becomes a
   * wait, which is the difference between a broken tab and a slow one.
   */
  const ADD_SLICE = 250;

  const addInSlices = async (described) => {
    for (let at = 0; at < described.length; at += ADD_SLICE) {
      try {
        uppy.addFiles(described.slice(at, at + ADD_SLICE));
      } catch (err) {
        uppy.log(err);
      }
      // Nothing is yielded after the last slice: a single-slice batch stays
      // synchronous, which is what every caller and test has always seen.
      if (at + ADD_SLICE < described.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  };

  /** Files chosen in the picker, as `{ name, type, data, meta }`. */
  const addPickedFiles = (descriptors) => {
    removeCompletedUploadFiles();
    configureUploadPlugin();
    const uploadTo = aimAtDestination();
    const batchId = createUploadBatchId();
    const described = (Array.isArray(descriptors) ? descriptors : []).map((descriptor) =>
      describeForUpload(descriptor, { uploadTo, batchId })
    );
    if (!described.length) return undefined;
    // In slices, so one state update each instead of one per file — and the
    // page is handed back between them.
    return addInSlices(described);
  };

  /**
   * Files dropped onto the page, as `getDroppedFiles` hands them over — each
   * with the path it had inside a dropped folder. Added the way Uppy's own
   * DropTarget adds them, which is what did it before.
   */
  const addDroppedFiles = (files) => {
    configureUploadPlugin();
    const uploadTo = aimAtDestination();
    const batchId = createUploadBatchId();
    const descriptors = (Array.isArray(files) ? files : []).map((file) => ({
      source: 'DropTarget',
      ...describeForUpload(
        {
          name: file.name,
          type: file.type,
          data: file,
          meta: {
            // path of the file relative to the ancestor directory the user
            // selected. e.g. 'docs/Old Prague/airbnb.pdf'
            relativePath: file.relativePath || null,
          },
        },
        { uploadTo, batchId }
      ),
    }));
    return addInSlices(descriptors);
  };

  const destroy = () => {
    if (uploadViewRefreshTimer) clearTimeout(uploadViewRefreshTimer);
    stopWatchingFinalization();
    clearFallbackTracking();
    Array.from(batchOf.keys()).forEach(finishUploadTask);
    // Uppy v5 uses `destroy()`. Older versions had `close()` in some setups.
    uppy.destroy?.();
    uppy.close?.();
    if (uppyStore.uppy === uppy) {
      uppyStore.uppy = null;
    }
  };

  // The upload mode depends on the settings: chosen again once they are in,
  // as the layout used to on mounting.
  try {
    await appSettings.ensureLoaded();
  } catch (_) {
    // Keep upload available with safe defaults if settings cannot be loaded.
  }
  configureUploadPlugin();

  return { uppy, configure: configureUploadPlugin, addPickedFiles, addDroppedFiles, destroy };
};
