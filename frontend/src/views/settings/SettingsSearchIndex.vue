<script setup>
import { computed, ref } from 'vue';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();
const appSettings = useAppSettings();

// The index is off unless someone asked for it, so this page is more often
// than not a form for something that is not running. It says so rather than
// accepting a list nobody will read.
const active = computed(() => featuresStore.searchIndexEnabled === true);

// Switched here unless SEARCH_INDEX decided, in which case the switch shows the
// value in force and cannot move (#9).
const lockedBy = computed(() => featuresStore.searchIndexLockedBy || null);
const saving = ref(false);

const setEnabled = async (enabled) => {
  if (lockedBy.value || saving.value) return;
  saving.value = true;
  try {
    await appSettings.save({ searchIndex: { enabled } });
    featuresStore.searchIndexEnabled = enabled;
  } catch {
    // The store keeps the error for the page; the switch stays where it was.
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <ExcludedPathsSettings
    settings-key="searchIndex"
    translation-prefix="settings.searchIndex"
    variable="SEARCH_INDEX"
    value="true"
    :active="active"
    :locked-by="lockedBy"
  >
    <template #control>
      <ToggleSwitch
        :model-value="active"
        :disabled="Boolean(lockedBy) || saving"
        :aria-label="$t('settings.searchIndex.running')"
        data-testid="search-index-switch"
        @update:model-value="setEnabled"
      />
    </template>
  </ExcludedPathsSettings>
</template>
