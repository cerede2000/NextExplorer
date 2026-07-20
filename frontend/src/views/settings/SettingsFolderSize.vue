<script setup>
import { computed, ref, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';

const appSettings = useAppSettings();
const { t } = useI18n();
const localPaths = ref([]);
const newPath = ref('');

const current = computed(
  () =>
    appSettings.systemSettings?.folderSize || { excludedPaths: [], environmentExcludedPaths: [] }
);
const environmentPaths = computed(() => current.value.environmentExcludedPaths || []);
const dirty = computed(
  () => JSON.stringify(localPaths.value) !== JSON.stringify(current.value.excludedPaths || [])
);

watch(
  current,
  (value) => {
    localPaths.value = [...(value.excludedPaths || [])];
  },
  { immediate: true, deep: true }
);

const addPath = () => {
  const path = newPath.value.trim().replace(/^\/+/, '');
  if (!path || localPaths.value.includes(path) || environmentPaths.value.includes(path)) return;
  localPaths.value = [...localPaths.value, path].sort((a, b) => a.localeCompare(b));
  newPath.value = '';
};

const removePath = (path) => {
  localPaths.value = localPaths.value.filter((value) => value !== path);
};

const save = () => appSettings.save({ folderSize: { excludedPaths: localPaths.value } });
const reset = () => {
  localPaths.value = [...(current.value.excludedPaths || [])];
  newPath.value = '';
};
</script>

<template>
  <div class="space-y-6">
    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <span class="text-sm">{{ t('common.unsavedChanges') }}</span>
      <div class="flex gap-2">
        <button
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
        <button
          class="rounded-md border border-current/20 px-3 py-1 hover:bg-white/10"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.folderSize.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.folderSize.subtitle') }}
      </p>
    </div>

    <section
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h3 class="font-medium text-zinc-900 dark:text-zinc-100">
        {{ t('settings.folderSize.environment') }}
      </h3>
      <div v-if="environmentPaths.length" class="mt-3 space-y-2">
        <div
          v-for="path in environmentPaths"
          :key="path"
          class="rounded-md bg-zinc-100 px-3 py-2 font-mono text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {{ path }}
        </div>
      </div>
      <p v-else class="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.folderSize.none') }}
      </p>
    </section>

    <section
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h3 class="font-medium text-zinc-900 dark:text-zinc-100">
        {{ t('settings.folderSize.additional') }}
      </h3>
      <div class="mt-4 flex gap-2">
        <input
          v-model="newPath"
          class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          :placeholder="t('settings.folderSize.placeholder')"
          @keydown.enter.prevent="addPath"
        />
        <button
          class="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          @click="addPath"
        >
          {{ t('common.add') }}
        </button>
      </div>
      <div v-if="localPaths.length" class="mt-4 space-y-2">
        <div
          v-for="path in localPaths"
          :key="path"
          class="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-700"
        >
          <span
            class="min-w-0 flex-1 truncate font-mono text-sm text-zinc-700 dark:text-zinc-200"
            >{{ path }}</span
          >
          <button
            class="text-sm text-red-600 hover:text-red-700 dark:text-red-400"
            @click="removePath(path)"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
      <p v-else class="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.folderSize.none') }}
      </p>
    </section>
  </div>
</template>
