<script setup>
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useConfigErrorGate } from '@/composables/useConfigErrorGate';
import { useAccountLanguage } from '@/composables/useAccountLanguage';
import ConfigErrorScreen from '@/components/ConfigErrorScreen.vue';
import ConfigWarningNotice from '@/components/ConfigWarningNotice.vue';

const { configError, dismissConfigWarning } = useConfigErrorGate();
// The language the signed-in account asked for, put on the screen. Here rather
// than in the settings store: half the application reads that store, and a
// store reaching into the translations would drag them into every component
// that touches a preference.
useAccountLanguage();

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
  <router-view v-else></router-view>
</template>
