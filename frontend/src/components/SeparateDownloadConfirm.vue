<script setup>
import { useI18n } from 'vue-i18n';
import ModalDialog from '@/components/ModalDialog.vue';
import { useSeparateDownloadConfirm } from '@/composables/useSeparateDownloadConfirm';

const { isOpen, fileCount, folderCount, cancel, chooseSeparate, chooseZip } =
  useSeparateDownloadConfirm();
const { t } = useI18n();
</script>

<template>
  <ModalDialog :model-value="isOpen" @update:model-value="(open) => !open && cancel()">
    <template #title>{{ t('download.confirmHeading', { count: fileCount }) }}</template>
    <p class="mb-4 text-base text-zinc-700 dark:text-zinc-200">
      {{ t('download.confirmBody', { count: fileCount }) }}
    </p>
    <p v-if="folderCount > 0" class="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
      {{ t('download.confirmFolders', { count: folderCount }) }}
    </p>
    <div class="flex flex-wrap justify-end gap-3">
      <button
        type="button"
        class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
        @click="chooseZip"
      >
        {{ t('download.confirmZip') }}
      </button>
      <button
        type="button"
        class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400"
        @click="chooseSeparate"
      >
        {{ t('download.confirmSeparate') }}
      </button>
    </div>
  </ModalDialog>
</template>
