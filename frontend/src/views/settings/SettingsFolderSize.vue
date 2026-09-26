<script setup>
import { computed } from 'vue';
import { useFeaturesStore } from '@/stores/features';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();

// The page was reachable and fully editable with folder sizes switched off,
// which meant a list could be curated for a feature that was not running and
// nothing on the page said so.
const mode = computed(() => featuresStore.folderSizeMode || 'off');
const active = computed(() => mode.value !== 'off');

// `FOLDER_SIZE_MODE` decides which of the three positions is in force —
// counting a folder's own entries and counting everything under it are
// different answers — so the page names the variable rather than offering a
// control that would change nothing (#9).
const lockedBy = computed(() => featuresStore.folderSizeLockedBy || 'FOLDER_SIZE_MODE');
</script>

<template>
  <ExcludedPathsSettings
    settings-key="folderSize"
    translation-prefix="settings.folderSize"
    variable="FOLDER_SIZE_MODE"
    value="full"
    :active="active"
    :locked-by="lockedBy"
  />
</template>
