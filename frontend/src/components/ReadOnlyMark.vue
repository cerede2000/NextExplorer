<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { LockClosedIcon } from '@heroicons/vue/20/solid';

/**
 * The mark beside a volume nothing can be written in, and why.
 *
 * A volume mounted read-only looked like any other until something was
 * attempted in it, and an administrator — whom no rule restricts — was offered
 * every write the system would then refuse (nxzai/NextExplorer#407). The
 * reason is the server's: `storage` for a read-only mount, `permission` for a
 * folder the server may not write in, `access` for an account a rule or an
 * assignment keeps to reading.
 */
const props = defineProps({
  reason: { type: String, default: null },
});

const { t } = useI18n();

const REASONS = {
  storage: 'volumes.readOnly.storage',
  permission: 'volumes.readOnly.permission',
  access: 'volumes.readOnly.access',
};

const explanation = computed(() => (REASONS[props.reason] ? t(REASONS[props.reason]) : ''));
</script>

<template>
  <span
    v-if="explanation"
    class="inline-flex shrink-0 items-center text-amber-600 dark:text-amber-400"
    :title="explanation"
    data-testid="volume-read-only"
    :data-reason="reason"
  >
    <LockClosedIcon class="h-3.5 w-3.5" aria-hidden="true" />
    <span class="sr-only">{{ t('volumes.readOnly.label') }} — {{ explanation }}</span>
  </span>
</template>
