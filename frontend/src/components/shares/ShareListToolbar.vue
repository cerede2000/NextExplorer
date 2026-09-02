<script setup>
import { useI18n } from 'vue-i18n';
import { MagnifyingGlassIcon, ArrowsUpDownIcon } from '@heroicons/vue/24/outline';

/**
 * The bar above both lists of share links: a title, three filters, a sort
 * toggle and a search box.
 *
 * It was written twice, seventy-seven lines each, and the copies had already
 * begun to drift — one list is a hundred and sixty pixels wider than the other
 * for no reason anybody wrote down. Whatever a screen wants to put after the
 * search box goes in the slot; everything before it is the same on both.
 */
defineProps({
  /** Already translated: the two screens name themselves differently. */
  title: { type: String, required: true },
});

const filterMode = defineModel('filterMode', { type: String, required: true });
const sortMode = defineModel('sortMode', { type: String, required: true });
const searchQuery = defineModel('searchQuery', { type: String, required: true });

const { t } = useI18n();

const FILTER_MODES = ['active', 'expired', 'all'];
</script>

<template>
  <div
    class="z-10 p-3 pl-12 lg:pl-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-default"
  >
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2 mr-4">
        <h1 class="font-medium text-neutral-800 dark:text-neutral-200 hidden sm:block text-lg ml-2">
          {{ title }}
        </h1>
      </div>

      <div class="flex items-center bg-neutral-100 dark:bg-neutral-800 rounded-md p-0.5">
        <button
          v-for="mode in FILTER_MODES"
          :key="mode"
          @click="filterMode = mode"
          class="px-3 py-1 text-xs font-medium rounded-sm transition-colors"
          :class="
            filterMode === mode
              ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm'
              : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
          "
        >
          {{ t(`common.${mode}`) }}
        </button>
      </div>

      <div class="h-6 w-px bg-neutral-200 dark:bg-neutral-700 mx-1"></div>

      <div class="flex items-center gap-2">
        <button
          @click="sortMode = sortMode === 'recent' ? 'label' : 'recent'"
          class="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
          :title="t('actions.sortBy')"
        >
          <ArrowsUpDownIcon class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1"></div>

      <div class="relative">
        <MagnifyingGlassIcon
          class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400"
        />
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('share.filterByNameOrPath')"
          class="pl-9 pr-3 py-1.5 text-sm bg-neutral-100 dark:bg-neutral-800 rounded-md border-none focus:ring-2 focus:ring-blue-500 w-48 transition-all focus:w-64"
        />
      </div>

      <slot name="after-search" />
    </div>
  </div>
</template>
