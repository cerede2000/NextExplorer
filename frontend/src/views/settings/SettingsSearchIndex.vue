<script setup>
import { computed } from 'vue';
import { useFeaturesStore } from '@/stores/features';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();

// The index is off unless someone asked for it, so this page is more often
// than not a form for something that is not running. It says so rather than
// accepting a list nobody will read.
const active = computed(() => featuresStore.searchIndexEnabled === true);
</script>

<template>
  <ExcludedPathsSettings
    settings-key="searchIndex"
    translation-prefix="settings.searchIndex"
    variable="SEARCH_INDEX"
    value="true"
    :active="active"
  />
</template>
