<script setup>
import { computed, ref, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';
import FeatureOffNotice from '@/components/settings/FeatureOffNotice.vue';

/**
 * A list of folders a feature is told to leave alone.
 *
 * Two features want exactly this page — folder sizes and the search index —
 * and had two copies of it, a hundred and fifty-six lines each, differing in
 * the settings key, the environment variable named in the notice, and how each
 * one decides whether its feature is running. The services behind them were
 * already one factory and two short callers; the pages had not followed, and a
 * fix made on one side would have quietly left the other behind.
 *
 * Whether the feature is on is asked of the caller rather than worked out here:
 * one reads a boolean, the other a mode that may be several things, and a
 * component that knew both would be back to holding two features in its head.
 */
const props = defineProps({
  /** Where this list lives in the system settings, and how it is saved. */
  settingsKey: { type: String, required: true },
  /** Whether the feature is running. A page for something switched off says so. */
  active: { type: Boolean, required: true },
  /** The environment variable that switches the feature on, named in the notice. */
  variable: { type: String, required: true },
  /** What that variable has to be set to. */
  value: { type: String, required: true },
  /** Where this page's own strings live, e.g. `settings.searchIndex`. */
  translationPrefix: { type: String, required: true },
});

const appSettings = useAppSettings();
const { t } = useI18n();

const label = (key) => t(`${props.translationPrefix}.${key}`);

const localPaths = ref([]);
const newPath = ref('');

const current = computed(
  () =>
    appSettings.systemSettings?.[props.settingsKey] || {
      excludedPaths: [],
      environmentExcludedPaths: [],
    }
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
  if (!props.active) return;
  const path = newPath.value.trim().replace(/^\/+/, '');
  if (!path || localPaths.value.includes(path) || environmentPaths.value.includes(path)) return;
  localPaths.value = [...localPaths.value, path].sort((a, b) => a.localeCompare(b));
  newPath.value = '';
};

const removePath = (path) => {
  localPaths.value = localPaths.value.filter((value) => value !== path);
};

const save = () => appSettings.save({ [props.settingsKey]: { excludedPaths: localPaths.value } });
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

    <FeatureOffNotice v-if="!active" :variable="variable" :value="value" />

    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ label('title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ label('subtitle') }}
      </p>
    </div>

    <section
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h3 class="font-medium text-zinc-900 dark:text-zinc-100">
        {{ label('environment') }}
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
        {{ label('none') }}
      </p>
    </section>

    <section
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
      :class="!active && 'opacity-60'"
    >
      <h3 class="font-medium text-zinc-900 dark:text-zinc-100">
        {{ label('additional') }}
      </h3>
      <div class="mt-4 flex gap-2">
        <input
          v-model="newPath"
          class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          :placeholder="label('placeholder')"
          :disabled="!active"
          @keydown.enter.prevent="addPath"
        />
        <button
          class="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          :disabled="!active"
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
            class="text-sm text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
            :disabled="!active"
            @click="removePath(path)"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
      <p v-else class="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        {{ label('none') }}
      </p>
    </section>
  </div>
</template>
