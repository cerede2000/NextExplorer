<template>
  <div class="h-full w-full bg-white dark:bg-zinc-900">
    <div
      v-if="error"
      class="flex h-full items-center justify-center text-sm text-red-600 dark:text-red-400"
    >
      {{ error }}
    </div>
    <div
      v-else-if="!ready"
      class="flex h-full items-center justify-center text-sm text-neutral-500 dark:text-neutral-400"
    >
      Loading ONLYOFFICE…
    </div>
    <DocumentEditor
      v-else
      class="h-full w-full"
      :key="editorId"
      :id="editorId"
      :shardkey="false"
      :documentServerUrl="serverUrl"
      :config="config"
    />

    <!--
      NextExplorer's own share dialog, opened from the editor's Share button.
      Dialogs teleport to the body, so they stack against the page and not
      against the overlay they were opened from — hence `elevated`, without
      which this one opens behind the editor.
    -->
    <ShareDialog v-model="isShareDialogOpen" :item="shareItem" elevated />

    <!--
      One picker for every request the editor makes — insert an image, choose a
      spreadsheet to merge from, pick a document to compare against. Which one
      is being answered is held in `pickerRequest`, since the editor only ever
      has one open at a time.
    -->
    <StoragePickerDialog
      v-model="isPickerOpen"
      :title="pickerTitle"
      :extensions="pickerExtensions"
      :initial-path="shareItem.path"
      elevated
      @select="handlePickerSelect"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { DocumentEditor } from '@onlyoffice/document-editor-vue';
import { useI18n } from 'vue-i18n';
import {
  fetchOnlyOfficeConfig,
  fetchOnlyOfficeMentionUsers,
  fetchOnlyOfficeStorageFile,
  heartbeatOnlyOfficeSession,
  notifyOnlyOfficeMention,
  requestOnlyOfficeForceSave,
  renameOnlyOfficeDocument,
  saveOnlyOfficeDocumentAs,
} from '@/api';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useSettingsStore } from '@/stores/settings';
import { usePreviewManager } from '@/plugins/preview/manager';
import ShareDialog from '@/components/ShareDialog.vue';
import StoragePickerDialog from '@/components/StoragePickerDialog.vue';
import logger from '@/utils/logger';

const AUTO_SAVE_DEBOUNCE_MS = 1200;

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  previewUrl: { type: String, required: true },
  previewState: { type: Object, required: true },
  api: { type: Object, required: true },
});

// previewState belongs to the preview manager and intentionally carries the
// small amount of state needed by the plugin close hook.
const previewState = props.previewState;

// The path the session is bound to. Starts as the prop and follows the file if
// it is renamed from the editor: the prop belongs to the preview manager, which
// has no way of knowing the rename happened, and every later call — heartbeat,
// force-save — would keep naming a file that no longer exists.
const documentPath = ref(props.filePath);
const { t } = useI18n();
const fileStore = useFileStore();
const notifications = useNotificationsStore();
const previewManager = usePreviewManager();
// The editor is dressed to match the app when it opens. ONLYOFFICE exposes no
// method to change the theme of a running editor — the only way to follow a
// switch made mid-edit would be to rebuild the editor, losing the cursor and
// the connection to co-authors for a change of colour.
const settings = useSettingsStore();
const serverUrl = ref(null);
const config = ref(null);
const error = ref(null);
const isShareDialogOpen = ref(false);
// Built from the live path rather than the item the preview was opened with,
// which still carries the old name after a rename from the title bar.
const shareItem = computed(() => {
  const full = documentPath.value || '';
  const cut = full.lastIndexOf('/');
  const name = cut === -1 ? full : full.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: cut === -1 ? '' : full.slice(0, cut),
    kind: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
});
const ready = computed(() => Boolean(serverUrl.value && config.value));
let autoSaveTimer = null;
let autoSaveInFlight = null;
let lastAutoSaveAt = 0;
let autoSaveIntervalMs = 0;
let changesObserved = false;
let disposed = false;
let sessionHeartbeatTimer = null;
const editorId = computed(() => {
  const base = (props.filePath || 'document').toString();
  return (
    'onlyoffice-' +
    base
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
  );
});

const clearAutoSaveTimer = () => {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
};

const clearSessionHeartbeat = () => {
  if (sessionHeartbeatTimer) clearInterval(sessionHeartbeatTimer);
  sessionHeartbeatTimer = null;
};

const startSessionHeartbeat = () => {
  clearSessionHeartbeat();
  const sessionId = previewState.forceSaveSessionId;
  // Never start one on the way out. Anything that can run after the preview is
  // gone — a refresh whose request was still in flight — would otherwise leave
  // an interval nobody owns, reporting the document as open every minute for
  // as long as the tab stays open.
  if (disposed || !documentPath.value || !sessionId) return;
  const heartbeat = () =>
    heartbeatOnlyOfficeSession(documentPath.value, { sessionId }).catch(() => {});
  heartbeat();
  sessionHeartbeatTimer = setInterval(heartbeat, 60_000);
};

/**
 * Fetch the converted document through the backend and land it beside the
 * original. The editor stays open on the document it already had — this saves a
 * copy, it does not switch to it.
 */
const saveDocumentAs = async (data) => {
  const title = data?.title;
  const url = data?.url;
  if (!documentPath.value || !title || !url) {
    logger.warn('ONLYOFFICE save-as request was incomplete', { title: title || null });
    return;
  }

  try {
    const saved = await saveOnlyOfficeDocumentAs(documentPath.value, { url, title });
    notifications.addNotification({
      type: 'success',
      heading: t('onlyoffice.savedAsHeading'),
      body: t('onlyoffice.savedAsBody', { name: saved?.name || title }),
    });
    // The file landed in the folder being browsed, so show it without waiting
    // for the next navigation.
    await fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
  } catch (e) {
    logger.error('ONLYOFFICE save-as failed', { path: documentPath.value, err: e });
    notifications.addNotification({
      type: 'error',
      heading: t('onlyoffice.saveAsFailed', { name: title }),
      body: e?.message || '',
    });
  }
};

/**
 * ONLYOFFICE sends the new title, sometimes as a bare string and sometimes
 * wrapped, depending on the editor. It does not include the extension, so it is
 * carried over from the current name — a document renamed to "Report" must not
 * become extensionless and stop opening.
 */
const renameDocument = async (data) => {
  const requested = String((typeof data === 'string' ? data : data?.title) || '').trim();
  const sessionId = previewState.forceSaveSessionId;
  if (!documentPath.value || !requested || !sessionId) return;

  const currentName = documentPath.value.split('/').pop() || '';
  const dot = currentName.lastIndexOf('.');
  const extension = dot > 0 ? currentName.slice(dot) : '';
  const newName =
    extension && !requested.toLowerCase().endsWith(extension.toLowerCase())
      ? `${requested}${extension}`
      : requested;

  try {
    const renamed = await renameOnlyOfficeDocument(documentPath.value, { sessionId, newName });
    // Follow the file. previewState carries it to the plugin's close hook,
    // which force-saves on the way out and would otherwise name the old path.
    documentPath.value = renamed?.path || documentPath.value;
    previewState.documentPath = documentPath.value;
    notifications.addNotification({
      type: 'success',
      heading: t('onlyoffice.renamedHeading'),
      body: t('onlyoffice.renamedBody', { name: renamed?.name || newName }),
    });
    await fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
  } catch (e) {
    logger.error('ONLYOFFICE rename failed', { path: documentPath.value, err: e });
    notifications.addNotification({
      type: 'error',
      heading: t('onlyoffice.renameFailed', { name: newName }),
      body: e?.message || '',
    });
  }
};

/**
 * What the editor can ask NextExplorer to find for it.
 *
 * Each entry says which files are worth showing and which editor method takes
 * the answer. The extensions are what the Document Server can actually read for
 * that purpose — offering a `.docx` to insert as an image only produces a
 * failure once it has been chosen.
 */
const PICKER_REQUESTS = {
  image: {
    titleKey: 'onlyoffice.pickImage',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'],
    method: 'insertImage',
  },
  document: {
    titleKey: 'onlyoffice.pickDocument',
    extensions: ['docx', 'doc', 'odt', 'rtf', 'txt'],
    method: 'setRequestedDocument',
  },
  spreadsheet: {
    titleKey: 'onlyoffice.pickSpreadsheet',
    extensions: ['xlsx', 'xls', 'ods', 'csv'],
    method: 'setRequestedSpreadsheet',
  },
  compare: {
    titleKey: 'onlyoffice.pickCompare',
    extensions: ['docx', 'doc', 'odt', 'rtf', 'txt'],
    method: 'setRevisedFile',
  },
};

const isPickerOpen = ref(false);
// Which request is being answered, and the `c` value that came with it: the
// editor uses `c` to match the answer to its request, and the backend signs it
// along with the URL.
const pickerRequest = ref(null);
const pickerCommand = ref(undefined);

const pickerTitle = computed(() => {
  const request = pickerRequest.value ? PICKER_REQUESTS[pickerRequest.value] : null;
  return request ? t(request.titleKey) : '';
});
const pickerExtensions = computed(() => {
  const request = pickerRequest.value ? PICKER_REQUESTS[pickerRequest.value] : null;
  return request ? request.extensions : [];
});

const openPicker = (kind, event) => {
  pickerRequest.value = kind;
  pickerCommand.value = event?.data?.c;
  isPickerOpen.value = true;
};

/**
 * Hand the chosen file back to the editor.
 *
 * The backend turns the path into a URL the Document Server can fetch, signed
 * for this one file; the editor downloads it itself, so nothing is streamed
 * through the browser.
 */
const handlePickerSelect = async (selectedPath) => {
  const request = pickerRequest.value ? PICKER_REQUESTS[pickerRequest.value] : null;
  const editor = window.DocEditor?.instances?.[editorId.value];
  if (!request || !editor) return;

  try {
    const payload = await fetchOnlyOfficeStorageFile(selectedPath, { c: pickerCommand.value });
    editor[request.method]?.(payload);
  } catch (pickerError) {
    logger.error('ONLYOFFICE could not hand over the selected file', {
      path: selectedPath,
      err: pickerError,
    });
    notifications.addNotification({
      type: 'error',
      heading: t('onlyoffice.pickFailed'),
      body: pickerError?.message || '',
    });
  }
};

/**
 * Point the running editor at the document as it now stands on disk.
 *
 * The Document Server reports the open version as outdated when the file it
 * was given has been replaced since — another editor saved it, or it was
 * overwritten from the file list. Fetching a fresh configuration is what
 * produces a new document key; handing it to `refreshFile` swaps the content
 * underneath the editor without tearing it down, which a full reload would do
 * at the cost of the cursor position and the co-editing session.
 *
 * The configuration carries a new editing session, so the identifier the
 * heartbeat and force-save calls quote has to be swapped with it.
 */
const refreshDocument = async () => {
  const path = documentPath.value;
  if (disposed || !path) return;

  const fresh = await fetchOnlyOfficeConfig(path, 'edit', {
    theme: settings.isDark ? 'dark' : 'light',
  });
  // Closing while this was in flight is ordinary: the editor reports an
  // outdated document as it saves on the way out. Adopting the session it just
  // created would revive a preview that no longer exists.
  if (disposed) return;
  previewState.forceSaveSessionId = fresh.forceSaveSessionId || null;
  autoSaveIntervalMs = Number(fresh.autoSaveIntervalMs) || 0;

  const editor = window.DocEditor?.instances?.[editorId.value];
  if (typeof editor?.refreshFile !== 'function') {
    // Older Document Servers have no such method; rebuilding the editor is the
    // only way left to stop showing a document that no longer exists.
    await load();
    return;
  }

  editor.refreshFile(fresh.config);
  startSessionHeartbeat();
};

const requestForceSave = async ({ reason = 'auto' } = {}) => {
  if (reason === 'close') clearAutoSaveTimer();
  const sessionId = previewState.forceSaveSessionId;
  if (!documentPath.value || !sessionId) return { queued: false };
  if (autoSaveInFlight) return autoSaveInFlight;

  autoSaveInFlight = requestOnlyOfficeForceSave(documentPath.value, { sessionId, reason })
    .then((result) => {
      lastAutoSaveAt = Date.now();
      return result;
    })
    .catch((saveError) => {
      logger.debug('ONLYOFFICE force-save request failed', saveError);
      throw saveError;
    })
    .finally(() => {
      autoSaveInFlight = null;
    });

  return autoSaveInFlight;
};

const scheduleAutoSave = () => {
  if (disposed || !changesObserved || autoSaveIntervalMs <= 0) return;

  clearAutoSaveTimer();
  const nextDelay = Math.max(
    AUTO_SAVE_DEBOUNCE_MS,
    lastAutoSaveAt + autoSaveIntervalMs - Date.now()
  );
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void requestForceSave({ reason: 'auto' }).catch(() => {});
  }, nextDelay);
};

const load = async () => {
  clearAutoSaveTimer();
  clearSessionHeartbeat();
  changesObserved = false;
  lastAutoSaveAt = 0;
  autoSaveIntervalMs = 0;
  error.value = null;
  serverUrl.value = null;
  config.value = null;
  previewState.forceSaveSessionId = null;
  previewState.hasNativeClose = false;
  try {
    const path = props.filePath;
    if (!path) throw new Error('Missing file path.');
    documentPath.value = path;
    previewState.documentPath = path;
    const {
      documentServerUrl,
      config: cfg,
      forceSaveSessionId,
      autoSaveIntervalMs: configuredAutoSaveIntervalMs,
    } = await fetchOnlyOfficeConfig(path, 'edit', {
      theme: settings.isDark ? 'dark' : 'light',
    });
    previewState.forceSaveSessionId = forceSaveSessionId || null;
    autoSaveIntervalMs = Number(configuredAutoSaveIntervalMs) || 0;
    previewState.requestForceSave = requestForceSave;
    cfg.events = {
      ...cfg.events,

      // Presence starts here, not when the configuration was fetched. Asking
      // for a configuration says nothing about whether the document opens, so
      // a file the editor refused used to be shown to everyone as being edited
      // until the session expired.
      onDocumentReady() {
        logger.debug('ONLYOFFICE document ready', { path: documentPath.value });
        startSessionHeartbeat();
        // The editor now draws its own close button, so the floating fallback
        // can step aside. It stays until this point on purpose: a document that
        // never opens leaves no editor chrome, and with it no way out.
        previewState.hasNativeClose = true;
      },

      // The editor's own close button. Route it through the preview manager
      // rather than closing the frame directly, so the plugin's close hook
      // still runs and the last changes are force-saved on the way out.
      onRequestClose() {
        void previewManager.close();
      },

      // The Share button in the editor's header. ONLYOFFICE offers it as soon
      // as something is listening and leaves the sharing itself to the
      // integration, so it opens the dialog the file list uses.
      onRequestSharingSettings() {
        isShareDialogOpen.value = true;
      },

      // Until now these three offered the local disk and a URL box, which is
      // an odd thing to be shown by a file manager: the document being edited
      // and the image to insert usually live in the same place.
      onRequestInsertImage(event) {
        openPicker('image', event);
      },

      onRequestSelectDocument(event) {
        openPicker('document', event);
      },

      onRequestSelectSpreadsheet(event) {
        openPicker('spreadsheet', event);
      },

      // Comparing against another version of the same document, which is
      // almost always the copy sitting beside it.
      onRequestCompareFile(event) {
        openPicker('compare', event);
      },

      // A comment was started with @. The editor takes the whole list and
      // filters it itself as the name is typed, so there is nothing to search
      // on; it also expects an answer even when the list is empty, or the
      // mention popup waits forever.
      onRequestUsers(event) {
        const editor = window.DocEditor?.instances?.[editorId.value];
        if (!editor?.setUsers) return;
        void fetchOnlyOfficeMentionUsers()
          .then((result) => {
            editor.setUsers({ c: event?.data?.c, users: result?.users || [] });
          })
          .catch((usersError) => {
            logger.debug('ONLYOFFICE mention list unavailable', usersError);
            editor.setUsers({ c: event?.data?.c, users: [] });
          });
      },

      // The mention is already written into the document; this is the separate
      // "tell them about it" step. NextExplorer has no channel to deliver it
      // on, so the backend records it and answers plainly instead of leaving
      // the editor waiting on a handler that does nothing.
      onRequestSendNotify(event) {
        const data = event?.data || {};
        void notifyOnlyOfficeMention(documentPath.value, {
          emails: data.emails,
          actionLink: data.actionLink,
          comment: data.message,
        }).catch((notifyError) => {
          logger.debug('ONLYOFFICE mention could not be recorded', notifyError);
        });
      },

      // The document on disk moved on without this editor. Until now nothing
      // listened, so the stale copy stayed on screen and the next save wrote
      // over whatever had replaced it.
      onOutdatedVersion() {
        logger.debug('ONLYOFFICE reported an outdated document', { path: documentPath.value });
        void refreshDocument().catch((refreshError) => {
          logger.error('ONLYOFFICE refresh failed', {
            path: documentPath.value,
            err: refreshError,
          });
        });
      },

      // ONLYOFFICE reports failures to whoever asks. Nobody did, so a document
      // that would not open showed a dialog to the user and left nothing
      // behind — the reason had to be reconstructed from the Document Server's
      // own logs, when it had written any.
      onError(event) {
        logger.error('ONLYOFFICE editor error', {
          path: documentPath.value,
          code: event?.data?.errorCode ?? null,
          description: event?.data?.errorDescription || null,
        });
      },

      onWarning(event) {
        logger.warn('ONLYOFFICE editor warning', {
          path: documentPath.value,
          code: event?.data?.warningCode ?? null,
          description: event?.data?.warningDescription || null,
        });
      },

      // ONLYOFFICE converts the document and hands over a URL; writing it is
      // ours to do. Without this the menu entry is hidden and Download — into
      // the browser's downloads, not the volume — is the only way out.
      onRequestSaveAs(event) {
        void saveDocumentAs(event?.data);
      },

      // Renaming from the editor's title bar. ONLYOFFICE only asks; the file
      // is ours to move, and the editing session has to follow it.
      onRequestRename(event) {
        void renameDocument(event?.data);
      },

      onDocumentStateChange(event) {
        if (typeof event?.data !== 'boolean') return;
        const pending = event.data;

        if (pending) {
          changesObserved = true;
          return;
        }

        // `false` means ONLYOFFICE delivered the current changes to Document
        // Server. Save that version at a bounded cadence so the external file
        // does not remain empty until the editor is closed.
        scheduleAutoSave();
      },
    };
    serverUrl.value = documentServerUrl;
    logger.debug('ONLYOFFICE config', cfg);
    config.value = cfg;
  } catch (e) {
    error.value = e?.message || 'Failed to initialize ONLYOFFICE.';
  }
};

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  clearAutoSaveTimer();
  clearSessionHeartbeat();
});
watch(
  () => props.filePath,
  () => {
    disposed = false;
    clearSessionHeartbeat();
    void load();
  }
);
</script>

<style scoped>
/* The editor fills the available area */
:deep(.onlyoffice-editor) {
  height: 100% !important;
}
</style>
