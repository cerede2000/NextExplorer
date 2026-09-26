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
  heartbeatOnlyOfficeSession,
  renameOnlyOfficeDocument,
} from '@/api';
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

const serverUrl = ref(null);
const config = ref(null);
const error = ref(null);
// The path the document is at *now*: renaming from the title bar moves it, and
// every later call — the heartbeat, ending the session — has to quote the new
// one or the server answers that the session is not for this document.
const documentPath = ref('');
const sessionId = ref(null);
let heartbeatTimer = null;
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

/** End the session, so the document stops being reported as open by whoever left. */
const endSession = ({ beacon = false } = {}) => {
  stopHeartbeat();
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
    } = await fetchOnlyOfficeConfig(path, 'edit');
    sessionId.value = editorSessionId || null;
    serverUrl.value = documentServerUrl;
    logger.debug('ONLYOFFICE config', cfg);
    cfg.events = {
      ...cfg.events,
      onDocumentReady() {
        logger.debug('ONLYOFFICE document ready', { path: documentPath.value });
        startHeartbeat();
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
