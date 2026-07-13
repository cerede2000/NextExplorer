<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';
import { getUploadFallbackMiB, resetUploadFallback } from '@/composables/fileUploader';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '@/components/ToggleSwitch.vue';

const appSettings = useAppSettings();
const features = useFeaturesStore();
const { t } = useI18n();

// Per-origin remembered auto-fallback chunk size (localStorage). The reset button
// forgets just this value → this address goes back to direct uploads.
const fallbackMiB = ref(getUploadFallbackMiB());
const resetFallback = () => {
  resetUploadFallback();
  fallbackMiB.value = null;
};

const MIB = 1024 * 1024;
const MIN_CHUNK_SIZE_MIB = 1;
const FALLBACK_MAX_CHUNK_SIZE_MIB = 512;
const DEFAULT_CHUNK_SIZE_MIB = 8;

onMounted(() => features.ensureLoaded());

// Server-driven ceiling (env MAX_CHUNK_SIZE_MIB); caps the slider/input.
const maxChunkSizeMiB = computed(() => {
  const bytes = features.maxUploadChunkSizeBytes;
  const mib =
    Number.isFinite(bytes) && bytes > 0
      ? Math.floor(bytes / MIB)
      : FALLBACK_MAX_CHUNK_SIZE_MIB;
  return Math.max(MIN_CHUNK_SIZE_MIB, mib);
});

const bytesToMiB = (bytes) => {
  const cap = maxChunkSizeMiB.value;
  if (!Number.isFinite(bytes) || bytes <= 0) return Math.min(DEFAULT_CHUNK_SIZE_MIB, cap);
  return Math.max(MIN_CHUNK_SIZE_MIB, Math.min(cap, Math.round(bytes / MIB)));
};

const local = reactive({
  chunkedEnabled: false,
  chunkedAutoFallback: false,
  chunkSizeMiB: DEFAULT_CHUNK_SIZE_MIB,
});

const original = computed(() => appSettings.systemSettings?.uploads || appSettings.state.uploads);
const originalChunkSizeMiB = computed(() => bytesToMiB(original.value?.chunkSizeBytes));
const dirty = computed(
  () =>
    local.chunkedEnabled !== Boolean(original.value?.chunkedEnabled) ||
    local.chunkedAutoFallback !== Boolean(original.value?.chunkedAutoFallback) ||
    local.chunkSizeMiB !== originalChunkSizeMiB.value
);

watch(
  () => appSettings.systemSettings?.uploads || appSettings.state.uploads,
  (uploads) => {
    if (!uploads) return;
    local.chunkedEnabled = Boolean(uploads.chunkedEnabled);
    local.chunkedAutoFallback = Boolean(uploads.chunkedAutoFallback);
    local.chunkSizeMiB = bytesToMiB(uploads.chunkSizeBytes);
  },
  { immediate: true }
);

// Forced chunking and auto-fallback are mutually exclusive: turning one on turns
// the other off.
watch(
  () => local.chunkedAutoFallback,
  (on) => {
    if (on) local.chunkedEnabled = false;
  }
);
watch(
  () => local.chunkedEnabled,
  (on) => {
    if (on) local.chunkedAutoFallback = false;
  }
);

// Keep the edited value within [min, server max] — auto-correct a value typed
// above the ceiling (e.g. after MAX_CHUNK_SIZE_MIB was lowered on the server).
watch([() => local.chunkSizeMiB, maxChunkSizeMiB], () => {
  const v = local.chunkSizeMiB;
  if (!Number.isFinite(v)) return;
  const clamped = Math.max(MIN_CHUNK_SIZE_MIB, Math.min(maxChunkSizeMiB.value, Math.round(v)));
  if (clamped !== v) local.chunkSizeMiB = clamped;
});

const reset = () => {
  const uploads = original.value;
  local.chunkedEnabled = Boolean(uploads?.chunkedEnabled);
  local.chunkedAutoFallback = Boolean(uploads?.chunkedAutoFallback);
  local.chunkSizeMiB = bytesToMiB(uploads?.chunkSizeBytes);
};

const save = async () => {
  await appSettings.save({
    uploads: {
      chunkedEnabled: local.chunkedEnabled,
      chunkedAutoFallback: local.chunkedAutoFallback,
      chunkSizeBytes: local.chunkSizeMiB * MIB,
    },
  });
};
</script>

<template>
  <div class="space-y-6">
    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <div class="text-sm">{{ t('common.unsavedChanges') }}</div>
      <div class="flex gap-2">
        <button
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
        <button
          class="rounded-md border border-white/10 px-3 py-1 hover:bg-white/10"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.uploads.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.uploads.subtitle') }}
      </p>
    </div>

    <div
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="space-y-6">
        <div
          class="flex items-center justify-between border-b border-zinc-100 py-3 dark:border-zinc-800"
        >
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.uploads.chunkedEnable') }}
            </div>
            <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {{ t('settings.uploads.chunkedEnableHelp') }}
            </div>
          </div>
          <ToggleSwitch v-model="local.chunkedEnabled" />
        </div>

        <div
          class="flex items-center justify-between py-3"
          :class="{ 'pointer-events-none opacity-60': !local.chunkedEnabled }"
        >
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.uploads.chunkSize') }}
            </div>
            <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {{ t('settings.uploads.chunkSizeHelp') }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="local.chunkSizeMiB"
              type="range"
              :min="MIN_CHUNK_SIZE_MIB"
              :max="maxChunkSizeMiB"
              step="1"
              class="h-2 w-64 appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-700 dark:accent-zinc-100"
            />
            <input
              v-model.number="local.chunkSizeMiB"
              type="number"
              :min="MIN_CHUNK_SIZE_MIB"
              :max="maxChunkSizeMiB"
              step="1"
              class="w-24 rounded-md border border-zinc-300 bg-white p-2 text-center text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 sm:text-sm"
            />
            <span class="text-sm text-zinc-500 dark:text-zinc-400">MiB</span>
          </div>
        </div>

        <div
          class="flex items-center justify-between border-t border-zinc-100 py-3 dark:border-zinc-800"
        >
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.uploads.autoFallback') }}
            </div>
            <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {{ t('settings.uploads.autoFallbackHelp') }}
            </div>
          </div>
          <ToggleSwitch v-model="local.chunkedAutoFallback" />
        </div>

        <div v-if="fallbackMiB" class="flex items-center justify-between py-2">
          <div class="text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('settings.uploads.autoFallbackActive', { size: fallbackMiB }) }}
          </div>
          <button
            type="button"
            class="rounded-md border border-zinc-300 px-3 py-1 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            @click="resetFallback"
          >
            {{ t('settings.uploads.autoFallbackReset') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
