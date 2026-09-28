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
  <!-- One viewport tall, as a column: the strip takes the height it needs and
       what a tab holds takes the rest. Before this the strip was simply added
       above a layout that was already `h-dvh`, so every screen was the viewport
       *plus* the strip — the page grew a scrollbar and the bottom of every folder
       was below the fold. `min-h-0` is what lets the row below actually shrink.

       No `overflow-hidden` here on purpose: the layouts that want to be exactly
       the viewport say so themselves, and the sign-in screen is taller than one
       on a small window and has to be able to scroll. -->
  <div v-else class="flex h-dvh flex-col">
    <!-- Drawn only where a tab can be, which the strip decides for itself. -->
    <TabStrip class="shrink-0" />
    <div class="relative min-h-0 flex-1">
      <router-view></router-view>
    </div>
  </div>
</template>
