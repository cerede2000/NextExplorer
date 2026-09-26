<script setup>
import { computed } from 'vue';
import { useFeaturesStore } from '@/stores/features';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();

// The index is off unless somebody asked for it, so this page is more often
// than not a form for something that is not running. It says so rather than
// accepting a list nobody will read.
const active = computed(() => featuresStore.searchIndexEnabled === true);

// `SEARCH_INDEX` decides whether it runs, so the page says which variable is
// in force rather than offering a switch that would change nothing (#9).
const lockedBy = computed(() => featuresStore.searchIndexLockedBy || 'SEARCH_INDEX');
</script>

<template>
  <ExcludedPathsSettings
    settings-key="searchIndex"
    translation-prefix="settings.searchIndex"
    variable="SEARCH_INDEX"
    value="true"
    :active="active"
    :locked-by="lockedBy"
  />
</template>
