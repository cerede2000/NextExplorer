<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onClickOutside } from '@vueuse/core';
import {
  ArrowDownTrayIcon,
  ChevronDownIcon,
  DocumentArrowDownIcon,
} from '@heroicons/vue/24/outline';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { useFileActions } from '@/composables/fileActions';

const actions = useFileActions();
const { t } = useI18n();

const hasSelection = actions.hasSelection;
// Only where the two ways differ: several things selected, at least one a file.
const canDownloadSeparately = actions.canDownloadSeparately;
const downloadMode = actions.downloadMode;

const handleDownload = () => {
  actions.runDownload();
};

const menuOpen = ref(false);
const menuPopup = ref(null);
onClickOutside(menuPopup, () => {
  menuOpen.value = false;
});

const pick = (mode) => {
  menuOpen.value = false;
  if (mode === 'separate') actions.runDownloadSeparately();
  else actions.runDownloadAsZip();
};
</script>

<template>
  <div class="flex gap-1 items-center">
    <!-- <button
      type="button"
      @click="handleRename"
      :disabled="!canRename"
      class="p-[6px] rounded-md transition-colors
        hover:bg-[rgb(239,239,240)] active:bg-zinc-200
        dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
      :class="{ 'opacity-50 cursor-not-allowed': !canRename }"
      title="Rename"
    >
      <Rename20Regular class="w-6" />
    </button> -->
    <div class="relative flex items-center">
      <button
        type="button"
        @click="handleDownload"
        :disabled="!hasSelection"
        class="p-[6px] rounded-md transition-colors hover:bg-[rgb(239,239,240)] active:bg-zinc-200 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
        :class="{
          'opacity-50 cursor-default pointer-events-none': !hasSelection,
        }"
        :title="$t('actions.download')"
      >
        <ArrowDownTrayIcon class="w-6" />
      </button>

      <button
        v-if="canDownloadSeparately"
        type="button"
        class="-ml-1 rounded-md p-[6px] transition-colors hover:bg-[rgb(239,239,240)] active:bg-zinc-200 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
        :class="{ 'dark:bg-zinc-700 dark:bg-opacity-70': menuOpen }"
        :title="t('download.chooseMode')"
        :aria-label="t('download.chooseMode')"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <ChevronDownIcon class="w-4" />
      </button>

      <transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="transform scale-95 opacity-0"
        enter-to-class="transform scale-100 opacity-100"
        leave-active-class="transition duration-75 ease-in"
        leave-from-class="transform scale-100 opacity-100"
        leave-to-class="transform scale-95 opacity-0"
      >
        <div
          v-if="menuOpen"
          ref="menuPopup"
          class="absolute right-0 top-full z-50 mt-1 w-64 origin-top-right rounded-md border border-neutral-200 bg-zinc-100 shadow-md dark:border-neutral-600 dark:bg-neutral-700"
        >
          <div class="flex flex-col gap-1 p-1">
            <button
              type="button"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 dark:hover:bg-neutral-600"
              @click="pick('zip')"
            >
              <ArrowDownTrayIcon class="h-5 w-5 shrink-0" />
              <span class="grow">{{ t('download.asZip') }}</span>
              <CheckIcon v-if="downloadMode === 'zip'" class="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-200 dark:hover:bg-neutral-600"
              @click="pick('separate')"
            >
              <DocumentArrowDownIcon class="h-5 w-5 shrink-0" />
              <span class="grow">{{ t('download.asSeparateFiles') }}</span>
              <CheckIcon v-if="downloadMode === 'separate'" class="h-4 w-4 shrink-0" />
            </button>
          </div>
        </div>
      </transition>
    </div>
    <!-- <button
      type="button"
      @click="handleDelete"
      :disabled="!hasSelection"
      class="p-[6px] rounded-md transition-colors
        hover:bg-[rgb(239,239,240)] active:bg-zinc-200
        dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
      :class="{ 'opacity-50 cursor-not-allowed': !hasSelection }"
      title="Delete"
    >
      <TrashIcon class="w-6" />
    </button> -->
  </div>
  <!-- <ModalDialog v-model="isDeleteConfirmOpen">
    <template #title>{{ deleteDialogTitle }}</template>
    <p class="mb-6 text-base text-zinc-700 dark:text-zinc-200">
      {{ deleteDialogMessage }}
    </p>
    <div class="flex justify-end gap-3">
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium rounded-md border border-zinc-300 text-zinc-700 transition-colors hover:bg-zinc-100 active:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
        @click="isDeleteConfirmOpen = false"
        :disabled="isDeleting"
        
      >
        Cancel
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium text-white rounded-md bg-red-600 transition-colors hover:bg-red-500 active:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-red-500 dark:hover:bg-red-400"
        @click="confirmDelete"
        :disabled="isDeleting"
      >
        <span v-if="isDeleting">Deleting...</span>
        <span v-else>Delete</span>
      </button>
    </div>
  </ModalDialog> -->
</template>
