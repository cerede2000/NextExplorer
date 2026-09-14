<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { TrashIcon } from '@heroicons/vue/24/outline';

/**
 * The way into the trash from the sidebar. One entry, not a section: there is
 * one trash per person, whatever the number of volumes it spans.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const isActive = computed(() => route.name === 'Trash');

const open = () => {
  router.push({ name: 'Trash' });
};
</script>

<template>
  <div class="mb-3 mt-2">
    <button
      type="button"
      data-test="trash-menu"
      class="flex w-full cursor-pointer items-center gap-3 truncate rounded-lg text-sm"
      :class="
        isActive ? 'text-neutral-950 dark:text-white' : 'text-neutral-950 dark:text-neutral-300/90'
      "
      :aria-current="isActive ? 'page' : undefined"
      @click="open"
    >
      <TrashIcon class="h-5 shrink-0" />
      <span class="truncate">{{ t('trash.menu') }}</span>
    </button>
  </div>
</template>
