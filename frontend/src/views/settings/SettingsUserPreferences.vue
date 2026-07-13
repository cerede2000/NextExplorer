<script setup>
import { computed, onMounted, reactive, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '@/components/ToggleSwitch.vue';

const appSettings = useAppSettings();
const features = useFeaturesStore();
const { t } = useI18n();

const local = reactive({
  showHiddenFiles: false,
  showThumbnails: true,
  showSidebarFavorites: true,
  showSidebarShares: true,
  showSidebarTools: true,
  defaultShareExpirationValue: null,
  defaultShareExpirationUnit: 'weeks',
  skipHome: null, // null = use env, true/false = override
});

const original = computed(() => appSettings.userSettings);
const dirty = computed(() => {
  const orig = original.value;
  const origExpiration = orig.defaultShareExpiration;
  const localExpiration = local.defaultShareExpirationValue
    ? { value: local.defaultShareExpirationValue, unit: local.defaultShareExpirationUnit }
    : null;

  return (
    local.showHiddenFiles !== orig.showHiddenFiles ||
    local.showThumbnails !== orig.showThumbnails ||
    local.showSidebarFavorites !== (orig.showSidebarFavorites ?? true) ||
    local.showSidebarShares !== (orig.showSidebarShares ?? true) ||
    local.showSidebarTools !== (orig.showSidebarTools ?? true) ||
    JSON.stringify(localExpiration) !== JSON.stringify(origExpiration) ||
    local.skipHome !== orig.skipHome
  );
});

const hiddenFilePatternsLabel = computed(() => {
  const patterns = Array.isArray(features.hiddenFilePatterns) ? features.hiddenFilePatterns : [];
  return patterns.length ? patterns.join(', ') : t('common.disabled');
});

onMounted(() => {
  features.ensureLoaded();
});

const sidebarPreferenceRows = [
  {
    key: 'showSidebarFavorites',
    label: 'settings.userPreferences.showSidebarFavorites',
    help: 'settings.userPreferences.showSidebarFavoritesHelp',
  },
  {
    key: 'showSidebarShares',
    label: 'settings.userPreferences.showSidebarShares',
    help: 'settings.userPreferences.showSidebarSharesHelp',
  },
  {
    key: 'showSidebarTools',
    label: 'settings.userPreferences.showSidebarTools',
    help: 'settings.userPreferences.showSidebarToolsHelp',
  },
];

watch(
  () => appSettings.userSettings,
  (userSettings) => {
    local.showHiddenFiles = userSettings.showHiddenFiles ?? false;
    local.showThumbnails = userSettings.showThumbnails ?? true;
    local.showSidebarFavorites = userSettings.showSidebarFavorites ?? true;
    local.showSidebarShares = userSettings.showSidebarShares ?? true;
    local.showSidebarTools = userSettings.showSidebarTools ?? true;

    const expiration = userSettings.defaultShareExpiration;
    if (expiration && typeof expiration === 'object') {
      local.defaultShareExpirationValue = expiration.value ?? null;
      local.defaultShareExpirationUnit = expiration.unit ?? 'weeks';
    } else {
      local.defaultShareExpirationValue = null;
      local.defaultShareExpirationUnit = 'weeks';
    }

    local.skipHome = userSettings.skipHome ?? null;
  },
  { immediate: true }
);

const reset = () => {
  const userSettings = appSettings.userSettings;
  local.showHiddenFiles = userSettings.showHiddenFiles ?? false;
  local.showThumbnails = userSettings.showThumbnails ?? true;
  local.showSidebarFavorites = userSettings.showSidebarFavorites ?? true;
  local.showSidebarShares = userSettings.showSidebarShares ?? true;
  local.showSidebarTools = userSettings.showSidebarTools ?? true;

  const expiration = userSettings.defaultShareExpiration;
  if (expiration && typeof expiration === 'object') {
    local.defaultShareExpirationValue = expiration.value ?? null;
    local.defaultShareExpirationUnit = expiration.unit ?? 'weeks';
  } else {
    local.defaultShareExpirationValue = null;
    local.defaultShareExpirationUnit = 'weeks';
  }

  local.skipHome = userSettings.skipHome ?? null;
};

const save = async () => {
  const defaultShareExpiration = local.defaultShareExpirationValue
    ? { value: local.defaultShareExpirationValue, unit: local.defaultShareExpirationUnit }
    : null;

  await appSettings.save({
    user: {
      showHiddenFiles: local.showHiddenFiles,
      showThumbnails: local.showThumbnails,
      showSidebarFavorites: local.showSidebarFavorites,
      showSidebarShares: local.showSidebarShares,
      showSidebarTools: local.showSidebarTools,
      defaultShareExpiration,
      skipHome: local.skipHome,
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

    <!-- Header -->
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.userPreferences.title') }}
      </h2>
      <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
        {{ t('settings.userPreferences.subtitle') }}
      </p>
    </div>

    <!-- Content -->
    <div
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6"
    >
      <div class="space-y-6">
        <div class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.userPreferences.showHiddenFiles') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{
                t('settings.userPreferences.showHiddenFilesHelp', {
                  patterns: hiddenFilePatternsLabel,
                })
              }}
            </div>
          </div>
          <ToggleSwitch v-model="local.showHiddenFiles" />
        </div>

        <div class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.userPreferences.showThumbnails') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.userPreferences.showThumbnailsHelp') }}
            </div>
          </div>
          <ToggleSwitch v-model="local.showThumbnails" />
        </div>

        <div
          v-for="row in sidebarPreferenceRows"
          :key="row.key"
          class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0"
        >
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t(row.label) }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t(row.help) }}
            </div>
          </div>
          <ToggleSwitch v-model="local[row.key]" />
        </div>

        <div class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.userPreferences.defaultShareExpiration') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.userPreferences.defaultShareExpirationHelp') }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <input
              type="number"
              min="1"
              v-model.number="local.defaultShareExpirationValue"
              :placeholder="t('settings.userPreferences.expirationValue')"
              class="w-20 rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border text-center"
            />
            <select
              v-model="local.defaultShareExpirationUnit"
              class="rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border"
            >
              <option value="days">{{ t('settings.userPreferences.days') }}</option>
              <option value="weeks">{{ t('settings.userPreferences.weeks') }}</option>
              <option value="months">{{ t('settings.userPreferences.months') }}</option>
            </select>
            <button
              v-if="local.defaultShareExpirationValue"
              @click="local.defaultShareExpirationValue = null"
              class="p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              :title="t('common.clear')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div class="flex items-center justify-between py-3">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.userPreferences.skipHome') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.userPreferences.skipHomeHelp') }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <select
              v-model="local.skipHome"
              class="rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border"
            >
              <option :value="null">{{ t('settings.userPreferences.useEnvSetting') }}</option>
              <option :value="true">{{ t('common.enabled') }}</option>
              <option :value="false">{{ t('common.disabled') }}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
