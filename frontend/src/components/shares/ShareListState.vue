<script setup>
import { useI18n } from 'vue-i18n';
import { ShareIcon } from '@heroicons/vue/24/outline';

/**
 * What a list of share links shows when it is not showing links: still
 * loading, failed to load, or genuinely empty.
 *
 * The third is the one worth having a component for. An empty list rendered as
 * an empty page reads as a broken screen, and both lists said so in their own
 * copy of the same twenty-six lines.
 */
defineProps({
  loading: { type: Boolean, default: false },
  /** The message to show, or empty when nothing went wrong. */
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  /** Already translated: each list says what it has none of. */
  emptyText: { type: String, required: true },
});

const emit = defineEmits(['retry']);

const { t } = useI18n();
</script>

<template>
  <div v-if="loading" class="flex h-full items-center justify-center">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
  </div>

  <div v-else-if="error" class="flex h-full flex-col items-center justify-center text-red-500">
    <p>{{ error }}</p>
    <button @click="emit('retry')" class="mt-2 text-blue-500 hover:underline">
      {{ t('common.tryAgain') }}
    </button>
  </div>

  <div v-else-if="empty" class="flex h-full flex-col items-center justify-center text-neutral-400">
    <ShareIcon class="w-16 h-16 mb-4 opacity-20" />
    <p>{{ emptyText }}</p>
  </div>

  <slot v-else />
</template>
