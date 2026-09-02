<script setup>
import { useI18n } from 'vue-i18n';
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline';

/**
 * Said on a settings page for a feature that is switched off.
 *
 * The page stays reachable on purpose — preparing a list before turning
 * something on is a reasonable thing to do — but a form that quietly governs
 * nothing is worse than one that says so. It names the variable to set, because
 * "not enabled" without that leaves someone hunting through documentation for
 * a word they have already read on this page.
 */
defineProps({
  variable: { type: String, required: true },
  value: { type: String, required: true },
});

const { t } = useI18n();
</script>

<template>
  <div
    class="flex items-start gap-3 rounded-lg border border-amber-400/40 bg-amber-50 p-4 text-amber-900 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200"
    data-testid="feature-off-notice"
  >
    <ExclamationTriangleIcon class="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
    <div class="min-w-0 space-y-1">
      <p class="text-sm font-medium">{{ t('settings.featureOff.title') }}</p>
      <p class="text-sm">
        <i18n-t keypath="settings.featureOff.howTo" tag="span" scope="global">
          <template #setting>
            <code class="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs"
              >{{ variable }}={{ value }}</code
            >
          </template>
        </i18n-t>
      </p>
      <p class="text-sm opacity-80">{{ t('settings.featureOff.kept') }}</p>
    </div>
  </div>
</template>
