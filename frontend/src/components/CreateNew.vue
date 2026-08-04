<script setup>
import { computed, ref, watch } from 'vue';
import { PlusIcon, ChevronRightIcon } from '@heroicons/vue/24/outline';
import { useToggle, onClickOutside } from '@vueuse/core';
import {
  CreateNewFolderRound,
  DriveFolderUploadOutlined,
  UploadFileOutlined,
  FileOpenOutlined,
  DescriptionOutlined,
} from '@vicons/material';

const popuplRef = ref(null);
const drawerOpen = ref(false);

const [menuOpen, toggle] = useToggle();

onClickOutside(popuplRef, () => {
  menuOpen.value = false;
});

// The drawer lives inside the menu, so it disappears with it — but its state
// does not. Without this it would be open again the next time the menu is.
watch(menuOpen, (open) => {
  if (!open) drawerOpen.value = false;
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

/**
 * What the "New file" drawer offers.
 *
 * `office` entries need an editor to be worth creating; the text ones are
 * useful on their own and are always listed. Order is deliberate: the office
 * formats are what the drawer was added for, the plain ones sit below.
 */
const DOCUMENT_TYPES = [
  {
    format: 'docx',
    office: true,
    titleKey: 'actions.newWordDocument',
    nameKey: 'create.defaultDocumentName',
    tint: 'text-blue-500',
  },
  {
    format: 'xlsx',
    office: true,
    titleKey: 'actions.newSpreadsheet',
    nameKey: 'create.defaultSpreadsheetName',
    tint: 'text-green-600',
  },
  {
    format: 'pptx',
    office: true,
    titleKey: 'actions.newPresentation',
    nameKey: 'create.defaultPresentationName',
    tint: 'text-orange-500',
  },
  {
    format: 'pdf',
    office: true,
    titleKey: 'actions.newPdf',
    nameKey: 'create.defaultDocumentName',
    tint: 'text-red-500',
  },
  {
    format: 'txt',
    titleKey: 'actions.newTextFile',
    nameKey: 'create.defaultDocumentName',
    tint: 'text-neutral-400',
  },
  {
    format: 'md',
    titleKey: 'actions.newMarkdownFile',
    nameKey: 'create.defaultDocumentName',
    tint: 'text-neutral-400',
  },
  {
    format: 'csv',
    titleKey: 'actions.newCsvFile',
    nameKey: 'create.defaultDataName',
    tint: 'text-green-600',
  },
];

const documentTypes = computed(() =>
  DOCUMENT_TYPES.filter((type) => !type.office || hasOfficeEditor.value)
);

const officeDialogOpen = ref(false);
const officeDocument = ref(DOCUMENT_TYPES[0]);

// The drawer opens on hover, which says nothing about where it fits. Measured
// against the viewport each time it opens: a menu near the right edge has to
// hand its drawer to the other side or it opens off-screen.
const drawerOnLeft = ref(false);
const newFileRef = ref(null);
const DRAWER_WIDTH = 240;

const openDrawer = () => {
  const rect = newFileRef.value?.getBoundingClientRect();
  if (rect) {
    const room = window.innerWidth - rect.right;
    drawerOnLeft.value = room < DRAWER_WIDTH && rect.left > room;
  }
  drawerOpen.value = true;
};

const closeMenus = () => {
  drawerOpen.value = false;
  menuOpen.value = false;
};

const promptOfficeDocument = (document) => {
  officeDocument.value = document;
  closeMenus();
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
      <!--
        "New file" keeps doing what it always did on click. The drawer beside
        it is where the typed documents live, so the common case stays one
        click and the choice is there for anyone who wants it.
      -->
      <div
        v-if="canCreateFile"
        ref="newFileRef"
        class="relative"
        @mouseenter="openDrawer"
        @mouseleave="drawerOpen = false"
      >
        <button
          @click="createFile"
          @keydown.right.prevent="openDrawer"
          @keydown.left.prevent="drawerOpen = false"
          :disabled="isCreating"
          :aria-expanded="drawerOpen"
          aria-haspopup="menu"
          class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white border-b border-gray-300 dark:border-gray-600 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <FileOpenOutlined class="w-6 text-orange-400" />
          <span class="flex-1 text-left">{{ $t('actions.newFile') }}</span>
          <ChevronRightIcon class="w-4 h-4 shrink-0 opacity-60" aria-hidden="true" />
        </button>

        <div
          v-if="drawerOpen"
          role="menu"
          class="absolute top-0 z-50 min-w-[240px] bg-white dark:bg-zinc-700 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-600"
          :class="drawerOnLeft ? 'right-full mr-1' : 'left-full ml-1'"
        >
          <button
            v-for="(type, index) in documentTypes"
            :key="type.format"
            role="menuitem"
            @click="promptOfficeDocument(type)"
            :disabled="isCreating"
            class="cursor-pointer w-full flex items-center gap-2 p-2 px-4 hover:bg-blue-500 hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
            :class="[
              index === 0 ? 'rounded-t-lg' : '',
              index === documentTypes.length - 1
                ? 'rounded-b-lg'
                : 'border-b border-gray-300 dark:border-gray-600',
            ]"
          >
            <DescriptionOutlined class="w-6 shrink-0" :class="type.tint" />
            <span class="flex-1 text-left whitespace-nowrap">{{ $t(type.titleKey) }}</span>
            <span class="shrink-0 text-xs opacity-60">.{{ type.format }}</span>
          </button>
        </div>
      </div>
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
