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
import { DocumentEditor } from '@onlyoffice/document-editor-vue';
import { fetchOnlyOfficeConfig, requestOnlyOfficeForceSave } from '@/api';
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
const serverUrl = ref(null);
const config = ref(null);
const error = ref(null);
const ready = computed(() => Boolean(serverUrl.value && config.value));
let autoSaveTimer = null;
let autoSaveInFlight = null;
let lastAutoSaveAt = 0;
let changesObserved = false;
let disposed = false;
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

const clearAutoSaveTimer = () => {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
};

const requestForceSave = async ({ reason = 'auto' } = {}) => {
  const sessionId = previewState.forceSaveSessionId;
  if (!props.filePath || !sessionId) return { queued: false };
  if (autoSaveInFlight) return autoSaveInFlight;

  autoSaveInFlight = requestOnlyOfficeForceSave(props.filePath, { sessionId, reason })
    .then((result) => {
      lastAutoSaveAt = Date.now();
      previewState.lastForceSaveAt = lastAutoSaveAt;
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
  const intervalMs = Number(previewState.autoSaveIntervalMs) || 0;
  if (disposed || !changesObserved || intervalMs <= 0) return;

  clearAutoSaveTimer();
  const nextDelay = Math.max(AUTO_SAVE_DEBOUNCE_MS, lastAutoSaveAt + intervalMs - Date.now());
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void requestForceSave({ reason: 'auto' }).catch(() => {});
  }, nextDelay);
};

const load = async () => {
  clearAutoSaveTimer();
  changesObserved = false;
  lastAutoSaveAt = 0;
  error.value = null;
  serverUrl.value = null;
  config.value = null;
  previewState.forceSaveSessionId = null;
  try {
    const path = props.filePath;
    if (!path) throw new Error('Missing file path.');
    const {
      documentServerUrl,
      config: cfg,
      forceSaveSessionId,
      autoSaveIntervalMs,
    } = await fetchOnlyOfficeConfig(path, 'edit');
    previewState.forceSaveSessionId = forceSaveSessionId || null;
    previewState.autoSaveIntervalMs = Number(autoSaveIntervalMs) || 0;
    previewState.requestForceSave = requestForceSave;
    cfg.events = {
      ...cfg.events,
      onDocumentStateChange(event) {
        const pending = Boolean(event?.data);
        previewState.changesPending = pending;

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
});
watch(
  () => props.filePath,
  () => {
    disposed = false;
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
