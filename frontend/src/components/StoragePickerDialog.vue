<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderIcon, DocumentIcon } from '@heroicons/vue/24/outline';
import ModalDialog from '@/components/ModalDialog.vue';
import { browse } from '@/api';
import logger from '@/utils/logger';

/**
 * Pick one file from the user's storage.
 *
 * Built for the editor, which needs a file chosen without leaving the document
 * — inserting an image, merging a spreadsheet, comparing against another
 * version. Deliberately plain: it browses and it picks, and everything else
 * about a file (renaming, sorting, thumbnails) belongs to the file list.
 *
 * Folders are always shown so a nested file remains reachable; files are shown
 * only when they are of a kind the caller asked for, because picking one that
 * cannot be used is a failure the caller can only report after the fact.
 */

const props = defineProps({
  modelValue: Boolean,
  title: { type: String, default: '' },
  /** Lowercase extensions, without the dot. Empty means every file. */
  extensions: { type: Array, default: () => [] },
  /** Folder to open on, usually the one holding the document being edited. */
  initialPath: { type: String, default: '' },
  elevated: Boolean,
});

const emit = defineEmits(['update:modelValue', 'select']);
const { t } = useI18n();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const currentPath = ref('');
const items = ref([]);
const isLoading = ref(false);
const error = ref('');

const accepted = computed(() => new Set(props.extensions.map((ext) => String(ext).toLowerCase())));

const entries = computed(() =>
  items.value.filter((item) => {
    if (item.kind === 'directory') return true;
    if (accepted.value.size === 0) return true;
    return accepted.value.has(String(item.kind || '').toLowerCase());
  })
);

const crumbs = computed(() => {
  const segments = String(currentPath.value || '')
    .split('/')
    .filter(Boolean);
  return segments.map((name, index) => ({
    name,
    path: segments.slice(0, index + 1).join('/'),
  }));
});

const navigate = async (target) => {
  isLoading.value = true;
  error.value = '';
  try {
    const listing = await browse(target || '');
    currentPath.value = listing?.path ?? target ?? '';
    items.value = Array.isArray(listing?.items) ? listing.items : [];
  } catch (browseError) {
    logger.debug('Storage picker could not list the folder', browseError);
    error.value = browseError?.message || '';
    items.value = [];
  } finally {
    isLoading.value = false;
  }
};

const fullPath = (item) => {
  const parent = item.path || '';
  return parent ? `${parent}/${item.name}` : item.name;
};

const choose = (item) => {
  if (item.kind === 'directory') {
    void navigate(fullPath(item));
    return;
  }
  emit('select', fullPath(item));
  isOpen.value = false;
};

watch(
  () => props.modelValue,
  (opened) => {
    if (!opened) return;
    // Reopening lands where the document is rather than where the last pick
    // left off: the two are unrelated often enough that resuming is a nuisance.
    void navigate(props.initialPath || '');
  },
  { immediate: true }
);
</script>

<template>
  <ModalDialog v-model="isOpen" :elevated="elevated">
    <template #title>{{ title }}</template>

    <div class="flex flex-col gap-3">
      <nav
        class="flex flex-wrap items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400"
        :aria-label="t('storagePicker.breadcrumb')"
      >
        <button
          type="button"
          class="rounded px-1 py-0.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-zinc-800 dark:hover:text-neutral-200"
          @click="navigate('')"
        >
          {{ t('storagePicker.root') }}
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <span aria-hidden="true">/</span>
          <button
            type="button"
            class="rounded px-1 py-0.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-zinc-800 dark:hover:text-neutral-200"
            @click="navigate(crumb.path)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </nav>

      <div
        class="h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-zinc-700"
        role="listbox"
      >
        <p v-if="isLoading" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ t('common.loadingEllipsis') }}
        </p>
        <p v-else-if="error" class="p-4 text-red-600 dark:text-red-400">{{ error }}</p>
        <p v-else-if="entries.length === 0" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ t('storagePicker.empty') }}
        </p>
        <ul v-else class="divide-y divide-neutral-100 dark:divide-zinc-800">
          <li v-for="item in entries" :key="`${item.path}/${item.name}`">
            <button
              type="button"
              role="option"
              :aria-selected="false"
              class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-zinc-800"
              @click="choose(item)"
            >
              <FolderIcon
                v-if="item.kind === 'directory'"
                class="h-4 w-4 shrink-0 text-blue-500"
                aria-hidden="true"
              />
              <DocumentIcon v-else class="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
              <span class="truncate">{{ item.name }}</span>
            </button>
          </li>
        </ul>
      </div>

      <div class="flex justify-end">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-zinc-800"
          @click="isOpen = false"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </ModalDialog>
</template>
