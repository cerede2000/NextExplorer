<script setup>
import { computed } from 'vue';
import { useFeaturesStore } from '@/stores/features';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();

// The page was reachable and fully editable with folder sizes switched off,
// which meant a list could be curated for a feature that was not running and
// nothing on the page said so.
const active = computed(() => (featuresStore.folderSizeMode || 'off') !== 'off');
</script>

<template>
  <ExcludedPathsSettings
    settings-key="folderSize"
    translation-prefix="settings.folderSize"
    variable="FOLDER_SIZE_MODE"
    value="full"
    :active="active"
  />
</template>
