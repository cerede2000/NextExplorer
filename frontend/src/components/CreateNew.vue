<script setup>
import { computed, ref } from 'vue';
import { PlusIcon } from '@heroicons/vue/24/outline';
import { useToggle, onClickOutside } from '@vueuse/core';
import {
  CreateNewFolderRound,
  DriveFolderUploadOutlined,
  UploadFileOutlined,
  FileOpenOutlined,
  DescriptionOutlined,
} from '@vicons/material';

const popuplRef = ref(null);

const [menuOpen, toggle] = useToggle();

onClickOutside(popuplRef, () => {
  menuOpen.value = false;
});

import { useI18n } from 'vue-i18n';
import { useFileUploader } from '@/composables/fileUploader';
import { useFileStore } from '@/stores/fileStore';
import { useFeaturesStore } from '@/stores/features';
import { useNotificationsStore } from '@/stores/notifications';
import { usePreviewManager } from '@/plugins/preview/manager';
import NewOfficeDocumentDialog from '@/components/NewOfficeDocumentDialog.vue';

const { openDialog } = useFileUploader();
const { t } = useI18n();
const fileStore = useFileStore();
const featuresStore = useFeaturesStore();
const notifications = useNotificationsStore();
const previewManager = usePreviewManager();
const isCreating = ref(false);
const canCreateFolder = computed(() => fileStore.currentPathData?.canCreateFolder ?? true);
const canCreateFile = computed(() => fileStore.currentPathData?.canCreateFile ?? true);
const canUpload = computed(() => fileStore.currentPathData?.canUpload ?? true);

/**
 * Blank documents are only worth offering when something can open them: with
 * no editor configured, this would create files the app can only download.
 */
const hasOfficeEditor = computed(
  () => featuresStore.onlyofficeEnabled || featuresStore.collaboraEnabled
);

const OFFICE_DOCUMENTS = [
  { format: 'docx', titleKey: 'actions.newWordDocument', nameKey: 'create.defaultDocumentName' },
  { format: 'xlsx', titleKey: 'actions.newSpreadsheet', nameKey: 'create.defaultSpreadsheetName' },
  {
    format: 'pptx',
    titleKey: 'actions.newPresentation',
    nameKey: 'create.defaultPresentationName',
  },
];

const officeDialogOpen = ref(false);
const officeDocument = ref(OFFICE_DOCUMENTS[0]);

const promptOfficeDocument = (document) => {
  officeDocument.value = document;
  menuOpen.value = false;
  officeDialogOpen.value = true;
};

/**
 * Create the document, then open it in the editor it was made for. Landing
 * back in the file list would leave the user to find and open a document they
 * just asked for by name.
 */
const createOfficeDocument = async ({ format, name }) => {
  if (isCreating.value) return;

  isCreating.value = true;
  try {
    const item = await fileStore.createOfficeDocument({ format, name });
    if (item) previewManager.open(item);
  } catch (error) {
    notifications.addNotification({
      type: 'error',
      heading: t('create.documentFailed'),
      body: error?.message || '',
    });
  } finally {
    isCreating.value = false;
  }
};

const uploadFolder = async () => {
  await openDialog({ directory: true });
  //process()
};

const uploadFiles = async () => {
  await openDialog();
  //process()
};

const createFolder = async () => {
  if (isCreating.value) return;

  isCreating.value = true;
  try {
    await fileStore.createFolder();
  } catch (error) {
    console.error('Failed to create folder', error);
  } finally {
    menuOpen.value = false;
    isCreating.value = false;
  }
};

const createFile = async () => {
  if (isCreating.value) return;

  isCreating.value = true;
  try {
    await fileStore.createFile();
  } catch (error) {
    console.error('Failed to create file', error);
  } finally {
    menuOpen.value = false;
    isCreating.value = false;
  }
};
</script>
<template>
  <div class="relative">
    <button
      @click="toggle()"
      class="inline-flex items-center justify-center rounded-lg bg-neutral-900 dark:bg-zinc-600/60 hover:bg-zinc-600 active:bg-zinc-700 px-2 py-1.5 text-xs font-medium text-white shadow-sm transition md:px-3 md:pl-2 md:py-2 md:text-sm"
      :title="$t('create.createNew')"
    >
      <PlusIcon class="w-4 h-4 md:mr-1" />
      <span class="hidden md:inline">
        {{ $t('create.createNew') }}
      </span>
    </button>

    <div
      ref="popuplRef"
      v-if="menuOpen"
      class="absolute top-full mt-2 left-0 z-50 min-w-[200px] bg-white dark:bg-zinc-700 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-600"
    >
      <button
        v-if="canCreateFolder"
        @click="createFolder"
        :disabled="isCreating"
        class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white border-b border-gray-300 dark:border-gray-600 rounded-t-lg disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <CreateNewFolderRound class="w-6 text-yellow-400" />
        {{ $t('actions.newFolder') }}
      </button>
      <button
        v-if="canCreateFile"
        @click="createFile"
        :disabled="isCreating"
        class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white border-b border-gray-300 dark:border-gray-600 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <FileOpenOutlined class="w-6 text-orange-400" />{{ $t('actions.newFile') }}
      </button>
      <button
        v-for="document in hasOfficeEditor && canCreateFile ? OFFICE_DOCUMENTS : []"
        :key="document.format"
        @click="promptOfficeDocument(document)"
        :disabled="isCreating"
        class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white border-b border-gray-300 dark:border-gray-600 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <DescriptionOutlined
          class="w-6"
          :class="{
            'text-blue-500': document.format === 'docx',
            'text-green-600': document.format === 'xlsx',
            'text-orange-500': document.format === 'pptx',
          }"
        />
        {{ $t(document.titleKey) }}
      </button>
      <button
        v-if="canUpload"
        @click="uploadFiles"
        class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white border-b border-gray-300 dark:border-gray-600"
      >
        <UploadFileOutlined class="w-6 text-sky-400" />{{ $t('actions.fileUpload') }}
      </button>
      <button
        v-if="canUpload"
        @click="uploadFolder"
        class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white rounded-b-lg"
      >
        <DriveFolderUploadOutlined class="w-6 text-green-400" />{{ $t('actions.folderUpload') }}
      </button>
    </div>

    <NewOfficeDocumentDialog
      v-model="officeDialogOpen"
      :format="officeDocument.format"
      :title="$t(officeDocument.titleKey)"
      :default-name="$t(officeDocument.nameKey)"
      @create="createOfficeDocument"
    />
  </div>
</template>
