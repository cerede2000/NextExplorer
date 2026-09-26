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
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { DocumentEditor } from '@onlyoffice/document-editor-vue';
import {
  endOnlyOfficeSession,
  fetchOnlyOfficeConfig,
  fetchOnlyOfficeHistory,
  fetchOnlyOfficeHistoryData,
  fetchOnlyOfficeMentionUsers,
  heartbeatOnlyOfficeSession,
  notifyOnlyOfficeMention,
  renameOnlyOfficeDocument,
  requestOnlyOfficeForceSave,
  restoreVersion,
  saveOnlyOfficeDocumentAs,
} from '@/api';
import { useFeaturesStore } from '@/stores/features';
import { useVersionsPanelStore } from '@/stores/versionsPanel';
import { formatLocalDateTime } from '@/utils';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import logger from '@/utils/logger';

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  previewUrl: { type: String, required: true },
  api: { type: Object, required: true },
});

const { t } = useI18n();
const fileStore = useFileStore();
const notifications = useNotificationsStore();
const featuresStore = useFeaturesStore();
const versionsPanel = useVersionsPanelStore();

/** Opened on an earlier version: a viewer, with nothing to save and no session. */
const viewedVersionId = computed(() =>
  typeof props.item?.versionId === 'string' ? props.item.versionId : ''
);

const serverUrl = ref(null);
const config = ref(null);
const error = ref(null);
// The path the document is at *now*: renaming from the title bar moves it, and
// every later call — the heartbeat, ending the session — has to quote the new
// one or the server answers that the session is not for this document.
const documentPath = ref('');
const sessionId = ref(null);
let heartbeatTimer = null;
let autoSaveTimer = null;
let autoSaveIntervalMs = 0;
let hasUnsavedChanges = false;
let disposed = false;

/**
 * Tell the server the document is open, and go on telling it.
 *
 * Started when ONLYOFFICE reports the document ready rather than when the
 * configuration was fetched: asking for a configuration says nothing about
 * whether the document opens, and a file the editor refused would otherwise be
 * shown to everybody as being edited until the session expired.
 */
const startHeartbeat = () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (disposed || !documentPath.value || !sessionId.value) return;
  const beat = () =>
    heartbeatOnlyOfficeSession(documentPath.value, { sessionId: sessionId.value }).catch(() => {});
  beat();
  heartbeatTimer = setInterval(beat, 60_000);
};

const stopHeartbeat = () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
};

/**
 * Write what the editor is holding, without waiting for it to decide.
 *
 * The Document Server writes the document through its own callback, which it
 * sends when it considers the document finished with — seconds after the last
 * keystroke, and long after the folder behind the editor has been listed again
 * with the old content. Asking for it explicitly is what makes an edit visible
 * where it was made.
 */
const forceSave = (reason) => {
  if (!documentPath.value || !sessionId.value) return Promise.resolve({ queued: false });
  return requestOnlyOfficeForceSave(documentPath.value, {
    sessionId: sessionId.value,
    reason,
  }).catch(() => ({ queued: false }));
};

const startAutoSave = () => {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  if (disposed || !autoSaveIntervalMs || !sessionId.value) return;
  autoSaveTimer = setInterval(() => {
    // Only when there is something to write: the editor tells us, and asking
    // for a save of an unchanged document costs a full conversion.
    if (hasUnsavedChanges) void forceSave('auto');
  }, autoSaveIntervalMs);
};

const stopAutoSave = () => {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = null;
};

/** End the session, so the document stops being reported as open by whoever left. */
const endSession = ({ beacon = false } = {}) => {
  stopHeartbeat();
  stopAutoSave();
  const current = sessionId.value;
  if (!current || !documentPath.value) return;
  sessionId.value = null;
  void endOnlyOfficeSession(documentPath.value, { sessionId: current, beacon }).catch(() => {});
};

const leaving = () => endSession({ beacon: true });

/**
 * Renaming from the editor's title bar.
 *
 * ONLYOFFICE only asks; the file is ours to move, and the editing session has
 * to follow it. The editor hands over a title without an extension, so the
 * file's own is put back — otherwise a rename quietly drops it.
 */
const renameDocument = async (data) => {
  const requested = String((typeof data === 'string' ? data : data?.title) || '').trim();
  if (!documentPath.value || !requested || !sessionId.value) return;

  const currentName = documentPath.value.split('/').pop() || '';
  const dot = currentName.lastIndexOf('.');
  const extension = dot > 0 ? currentName.slice(dot) : '';
  const newName =
    extension && !requested.toLowerCase().endsWith(extension.toLowerCase())
      ? `${requested}${extension}`
      : requested;

  try {
    const renamed = await renameOnlyOfficeDocument(documentPath.value, {
      sessionId: sessionId.value,
      newName,
    });
    documentPath.value = renamed?.path || documentPath.value;
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
const ready = computed(() => Boolean(serverUrl.value && config.value));
const editorId = computed(() => {
  const base = (props.context?.filePath || 'document').toString();
  return (
    'onlyoffice-' +
    base
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
  );
});

/** The live editor, which is how ONLYOFFICE takes answers to what it asked. */
const editorInstance = () => window.DocEditor?.instances?.[editorId.value];

/** Which of our version ids each number in the editor's history stands for. */
let historyVersionIds = new Map();

const showHistory = async () => {
  const editor = editorInstance();
  if (!editor?.refreshHistory) return;
  try {
    const result = await fetchOnlyOfficeHistory(documentPath.value);
    historyVersionIds = new Map(result.history.map((entry) => [entry.version, entry.versionId]));
    editor.refreshHistory({
      currentVersion: result.currentVersion,
      history: result.history.map((entry) => ({
        version: entry.version,
        key: entry.key,
        created: formatLocalDateTime(entry.created),
        user: entry.user,
      })),
    });
  } catch (historyError) {
    logger.error('ONLYOFFICE history unavailable', historyError);
    editor.refreshHistory({ error: historyError?.message || '' });
  }
};

const showHistoryEntry = async (version) => {
  const editor = editorInstance();
  if (!editor?.setHistoryData) return;
  try {
    editor.setHistoryData(
      await fetchOnlyOfficeHistoryData(documentPath.value, {
        version,
        versionId: historyVersionIds.get(version) || undefined,
      })
    );
  } catch (dataError) {
    editor.setHistoryData({ version, error: dataError?.message || t('versions.loadFailed') });
  }
};

const restoreFromHistory = async (version) => {
  const versionId = historyVersionIds.get(version);
  // The current state is already the document.
  if (!versionId) return;
  try {
    const result = await restoreVersion(documentPath.value, versionId);
    const unchanged = result?.status === 'unchanged';
    notifications.addNotification({
      type: unchanged ? 'info' : 'success',
      heading: unchanged ? t('versions.results.unchanged') : t('versions.results.restored'),
      durationMs: 4000,
    });
    versionsPanel.markRestored();
    await fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
    // The editor is still showing the history, over what the restore replaced.
    await load();
  } catch (restoreError) {
    notifications.addNotification({
      type: 'error',
      heading: t('versions.errors.action'),
      body: restoreError?.message || '',
    });
  }
};

/**
 * The editor's own history panel, where the document has a history to show.
 *
 * Left out entirely when a version is what is being read: a history inside a
 * history is a way to lose track of which document is on screen.
 */
const historyEvents = (cfg) => {
  if (viewedVersionId.value || !featuresStore.versionsEnabled) return {};
  const events = {
    onRequestHistory() {
      void showHistory();
    },
    onRequestHistoryData(event) {
      void showHistoryEntry(Number(event?.data));
    },
    onRequestHistoryClose() {
      void load();
    },
  };
  // Restore is only offered to somebody who may change the document.
  if (cfg?.document?.permissions?.edit) {
    events.onRequestRestore = (event) => {
      void restoreFromHistory(Number(event?.data?.version));
    };
  }
  return events;
};

/**
 * "Save as" from the editor's menu.
 *
 * ONLYOFFICE converts the document and hands over a URL; the server fetches it
 * and writes the copy beside the original. Without this the entry is hidden and
 * Download is the only way out — through the browser, into the person's
 * downloads rather than their volume.
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

const load = async () => {
  endSession();
  error.value = null;
  serverUrl.value = null;
  config.value = null;
  try {
    const path = props.filePath;
    if (!path) throw new Error('Missing file path.');
    documentPath.value = path;
    const {
      documentServerUrl,
      config: cfg,
      editorSessionId,
      autoSaveIntervalMs: configuredAutoSaveIntervalMs,
    } = await fetchOnlyOfficeConfig(path, viewedVersionId.value ? 'view' : 'edit', {
      ...(viewedVersionId.value ? { versionId: viewedVersionId.value } : {}),
    });
    sessionId.value = editorSessionId || null;
    autoSaveIntervalMs = Number(configuredAutoSaveIntervalMs) || 0;
    hasUnsavedChanges = false;
    serverUrl.value = documentServerUrl;
    logger.debug('ONLYOFFICE config', cfg);
    cfg.events = {
      ...cfg.events,
      ...historyEvents(cfg),
      // Saving a copy from the editor's menu, which is the only way out of the
      // editor that lands in the volume rather than in the browser.
      onRequestSaveAs(event) {
        void saveDocumentAs(event?.data);
      },
      // A comment was started with @. The editor takes the whole list and
      // filters it itself as the name is typed, so there is nothing to search
      // on; it also expects an answer even when the list is empty, or the
      // mention popup waits for ever.
      onRequestUsers(event) {
        const editor = editorInstance();
        if (!editor?.setUsers) return;
        void fetchOnlyOfficeMentionUsers()
          .then((result) => editor.setUsers({ c: event?.data?.c, users: result?.users || [] }))
          .catch((usersError) => {
            logger.debug('ONLYOFFICE mention list unavailable', usersError);
            editor.setUsers({ c: event?.data?.c, users: [] });
          });
      },
      // The comment is already in the document; this is the separate "tell
      // them" step, which ONLYOFFICE leaves to the integration.
      onRequestSendNotify(event) {
        const data = event?.data || {};
        void notifyOnlyOfficeMention(documentPath.value, {
          emails: data.emails,
          actionLink: data.actionLink,
          comment: data.message,
        }).catch((notifyError) => logger.debug('ONLYOFFICE mention not sent', notifyError));
      },
      onDocumentReady() {
        logger.debug('ONLYOFFICE document ready', { path: documentPath.value });
        startHeartbeat();
        startAutoSave();
      },
      // The editor says whether it is holding anything unwritten, which is what
      // decides whether a periodic save is worth a document conversion.
      onDocumentStateChange(event) {
        if (typeof event?.data === 'boolean') hasUnsavedChanges = event.data;
      },
      onRequestRename(event) {
        void renameDocument(event?.data);
      },
    };
    config.value = cfg;
  } catch (e) {
    error.value = e?.message || 'Failed to initialize ONLYOFFICE.';
  }
};

onMounted(() => {
  // A tab being closed gives one synchronous moment; the beacon is what
  // survives it.
  window.addEventListener('pagehide', leaving);
  void load();
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('pagehide', leaving);
  endSession();
});

watch(
  () => props.filePath,
  () => load()
);
</script>

<style scoped>
/* The editor fills the available area */
:deep(.onlyoffice-editor) {
  height: 100% !important;
}
</style>
