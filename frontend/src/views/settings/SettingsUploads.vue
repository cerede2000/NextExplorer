<script setup>
import { computed, reactive, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';

const appSettings = useAppSettings();
const { t } = useI18n();

const MIB = 1024 * 1024;
const MIN_CHUNK_SIZE_MIB = 1;
const MAX_CHUNK_SIZE_MIB = 512;
const DEFAULT_CHUNK_SIZE_MIB = 8;

const bytesToMiB = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_CHUNK_SIZE_MIB;
  return Math.max(MIN_CHUNK_SIZE_MIB, Math.min(MAX_CHUNK_SIZE_MIB, Math.round(bytes / MIB)));
};

const local = reactive({
  chunkedEnabled: false,
  chunkSizeMiB: DEFAULT_CHUNK_SIZE_MIB,
});

const original = computed(() => appSettings.systemSettings?.uploads || appSettings.state.uploads);
const originalChunkSizeMiB = computed(() => bytesToMiB(original.value?.chunkSizeBytes));
const dirty = computed(
  () =>
    local.chunkedEnabled !== Boolean(original.value?.chunkedEnabled) ||
    local.chunkSizeMiB !== originalChunkSizeMiB.value
);

watch(
  () => appSettings.systemSettings?.uploads || appSettings.state.uploads,
  (uploads) => {
    if (!uploads) return;
    local.chunkedEnabled = Boolean(uploads.chunkedEnabled);
    local.chunkSizeMiB = bytesToMiB(uploads.chunkSizeBytes);
  },
  { immediate: true }
);

const reset = () => {
  const uploads = original.value;
  local.chunkedEnabled = Boolean(uploads?.chunkedEnabled);
  local.chunkSizeMiB = bytesToMiB(uploads?.chunkSizeBytes);
};

const save = async () => {
  await appSettings.save({
    uploads: {
      chunkedEnabled: local.chunkedEnabled,
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
          <label class="inline-flex cursor-pointer items-center">
            <input v-model="local.chunkedEnabled" type="checkbox" class="peer sr-only" />
            <div
              class="peer relative h-6 w-11 rounded-full bg-zinc-200 transition-colors peer-checked:bg-zinc-900 dark:bg-zinc-700 dark:peer-checked:bg-zinc-100"
            >
              <div
                class="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5"
              ></div>
            </div>
          </label>
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
              :max="MAX_CHUNK_SIZE_MIB"
              step="1"
              class="h-2 w-64 appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-700 dark:accent-zinc-100"
            />
            <input
              v-model.number="local.chunkSizeMiB"
              type="number"
              :min="MIN_CHUNK_SIZE_MIB"
              :max="MAX_CHUNK_SIZE_MIB"
              step="1"
              class="w-24 rounded-md border border-zinc-300 bg-white p-2 text-center text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 sm:text-sm"
            />
            <span class="text-sm text-zinc-500 dark:text-zinc-400">MiB</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
