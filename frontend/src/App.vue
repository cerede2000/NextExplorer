<script setup>
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useAccountLanguage } from '@/composables/useAccountLanguage';
import { useConfigErrorGate } from '@/composables/useConfigErrorGate';
import ConfigErrorScreen from '@/components/ConfigErrorScreen.vue';
import ConfigWarningNotice from '@/components/ConfigWarningNotice.vue';

const { configError, dismissConfigWarning } = useConfigErrorGate();

// The account's language, applied for as long as the application is on screen.
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
