<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';

/**
 * How uploads go out, for an administrator.
 *
 * A direct upload is one request and much faster, and it is what an upload has
 * always been here. It is also what a reverse proxy refuses outright once the
 * body passes whatever limit it enforces, and what a dropped connection loses
 * entirely however far it had got. Chunked uploads answer both: each part is
 * small enough to pass, and one that fails is retried without sending again
 * what is already there.
 */

const MIB = 1024 * 1024;
const MIN_CHUNK_SIZE_MIB = 1;
const FALLBACK_MAX_CHUNK_SIZE_MIB = 512;
const DEFAULT_CHUNK_SIZE_MIB = 8;

const appSettings = useAppSettings();
const featuresStore = useFeaturesStore();
const { t } = useI18n();

onMounted(() => featuresStore.ensureLoaded());

// The ceiling the server allows (MAX_CHUNK_SIZE_MIB): said here rather than
// discovered by having a number refused.
const maxChunkSizeMiB = computed(() => {
  const bytes = featuresStore.maxUploadChunkSizeBytes;
  const mib =
    Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / MIB) : FALLBACK_MAX_CHUNK_SIZE_MIB;
  return Math.max(MIN_CHUNK_SIZE_MIB, mib);
});

const current = computed(
  () => appSettings.systemSettings?.uploads || { chunkedEnabled: false, chunkSizeBytes: 8 * MIB }
);

const bytesToMiB = (bytes) => {
  const cap = maxChunkSizeMiB.value;
  if (!Number.isFinite(bytes) || bytes <= 0) return Math.min(DEFAULT_CHUNK_SIZE_MIB, cap);
  return Math.max(MIN_CHUNK_SIZE_MIB, Math.min(cap, Math.round(bytes / MIB)));
};

const fromSettings = (settings) => ({
  chunkedEnabled: settings.chunkedEnabled === true,
  chunkSizeMiB: String(bytesToMiB(settings.chunkSizeBytes)),
});

const local = ref(fromSettings(current.value));

watch(
  current,
  (value) => {
    local.value = fromSettings(value);
  },
  { deep: true }
);

const chunkSizeMiB = computed(() => {
  const value = Number(local.value.chunkSizeMiB);
  return Number.isInteger(value) && value >= MIN_CHUNK_SIZE_MIB && value <= maxChunkSizeMiB.value
    ? value
    : null;
});

const invalid = computed(() => chunkSizeMiB.value === null);
const dirty = computed(
  () => JSON.stringify(local.value) !== JSON.stringify(fromSettings(current.value))
);

const saving = ref(false);
const saveError = ref('');

const save = async () => {
  if (invalid.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await appSettings.save({
      uploads: {
        chunkedEnabled: local.value.chunkedEnabled,
        chunkSizeBytes: chunkSizeMiB.value * MIB,
      },
    });
  } catch (err) {
    saveError.value =
      err?.message || t('settings.uploads.chunkSizeInvalid', { max: maxChunkSizeMiB });
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.uploads.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.uploads.subtitle') }}
      </p>
    </div>

    <div
      class="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex items-center justify-between py-3">
        <div>
          <div class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.uploads.chunkedEnable') }}
          </div>
          <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('settings.uploads.chunkedEnableHelp') }}
          </div>
        </div>
        <ToggleSwitch v-model="local.chunkedEnabled" data-test="uploads-chunked" />
      </div>

      <div
        class="flex items-center justify-between border-t border-zinc-100 py-3 dark:border-zinc-800"
      >
        <div>
          <label for="upload-chunk-size" class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.uploads.chunkSize') }}
          </label>
          <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('settings.uploads.chunkSizeHelp', { max: maxChunkSizeMiB }) }}
          </div>
        </div>
        <input
          id="upload-chunk-size"
          v-model="local.chunkSizeMiB"
          type="number"
          :min="MIN_CHUNK_SIZE_MIB"
          :max="maxChunkSizeMiB"
          :disabled="!local.chunkedEnabled"
          data-test="uploads-chunk-size"
          class="w-24 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </div>
    </div>

    <p v-if="saveError" class="text-sm text-red-600 dark:text-red-400">{{ saveError }}</p>

    <div class="flex justify-end">
      <button
        type="button"
        :disabled="!dirty || invalid || saving"
        data-test="uploads-save"
        class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-blue-500"
        @click="save"
      >
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </div>
  </div>
</template>
