<script setup>
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useAccountLanguage } from '@/composables/useAccountLanguage';
import { useConfigErrorGate } from '@/composables/useConfigErrorGate';
import { useTabRouteSync } from '@/composables/tabNavigation';
import ConfigErrorScreen from '@/components/ConfigErrorScreen.vue';
import ConfigWarningNotice from '@/components/ConfigWarningNotice.vue';
import TabStrip from '@/components/TabStrip.vue';

const { configError, dismissConfigWarning } = useConfigErrorGate();

// The account's language, applied for as long as the application is on screen.
useAccountLanguage();

// The tab in front says where the router is. Here rather than in the strip: the
// strip is only drawn where a tab can be, and the tabs have to keep up with the
// address wherever it goes.
useTabRouteSync();

const blockingConfigError = computed(() => configError.value?.mode === 'error');
const configWarning = computed(() =>
  configError.value?.mode === 'mismatch' ? configError.value : null
);
</script>

<template>
  <ConfigWarningNotice
    v-if="configWarning"
    :expected-origin="configWarning.expectedOrigin"
    :request-origin="configWarning.requestOrigin"
    @dismiss="dismissConfigWarning"
  />
  <ConfigErrorScreen
    v-if="blockingConfigError"
    :mode="configError.mode"
    :expected-origin="configError.expectedOrigin"
    :request-origin="configError.requestOrigin"
  />
  <template v-else>
    <!-- Above everything a tab can hold, and drawn only where one can be: the
         strip decides that for itself. -->
    <TabStrip />
    <router-view></router-view>
  </template>
</template>
