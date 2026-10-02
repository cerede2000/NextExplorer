<script setup>
import { computed, reactive, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';

const appSettings = useAppSettings();
const { t } = useI18n();
const local = reactive({ ffmpegPath: '', ffprobePath: '' });
const original = computed(() => appSettings.systemSettings.ffmpeg || {});

const reset = () => {
  local.ffmpegPath = original.value.ffmpegPath || '';
  local.ffprobePath = original.value.ffprobePath || '';
};

watch(original, reset, { immediate: true, deep: true });

const dirty = computed(
  () =>
    local.ffmpegPath !== (original.value.ffmpegPath || '') ||
    local.ffprobePath !== (original.value.ffprobePath || '')
);
const invalid = computed(() =>
  [local.ffmpegPath, local.ffprobePath].some((value) => value && !value.startsWith('/'))
);

const save = async () => {
  if (invalid.value) return;
  await appSettings.save({
    ffmpeg: {
      ffmpegPath: local.ffmpegPath || null,
      ffprobePath: local.ffprobePath || null,
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
          type="button"
          data-test="ffmpeg-settings-save"
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400 disabled:opacity-50"
          :disabled="invalid"
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
        {{ t('settings.ffmpeg.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.ffmpeg.subtitle') }}
      </p>
    </div>

    <div
      class="space-y-5 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <p class="text-sm text-zinc-600 dark:text-zinc-300">
        {{ t('settings.ffmpeg.containerPathHelp') }}
      </p>
      <label class="block">
        <span class="font-medium text-zinc-900 dark:text-zinc-100">{{
          t('settings.ffmpeg.ffmpegPath')
        }}</span>
        <input
          v-model.trim="local.ffmpegPath"
          data-test="ffmpeg-path"
          type="text"
          placeholder="/usr/local/bin/ffmpeg"
          class="mt-2 w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </label>
      <label class="block">
        <span class="font-medium text-zinc-900 dark:text-zinc-100">{{
          t('settings.ffmpeg.ffprobePath')
        }}</span>
        <input
          v-model.trim="local.ffprobePath"
          data-test="ffprobe-path"
          type="text"
          placeholder="/usr/local/bin/ffprobe"
          class="mt-2 w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </label>
      <p v-if="invalid" data-test="ffmpeg-settings-invalid" class="text-sm text-red-600">
        {{ t('settings.ffmpeg.invalid') }}
      </p>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('settings.ffmpeg.defaultHelp') }}</p>
    </div>
  </div>
</template>
