<script setup>
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderIcon, DocumentIcon } from '@heroicons/vue/24/outline';
import ModalDialog from '@/components/ModalDialog.vue';
import { useStorageBrowser } from '@/composables/useStorageBrowser';

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
 *
 * With `chooseFolder` the answer is a folder instead — the one being looked at,
 * chosen with the button below the list — and files are not shown at all. An
 * access rule is written for a folder, and typing its path was the only way to
 * give one: typed from the host's side of a mount, it named nothing
 * (nxzai/NextExplorer#407).
 */

const props = defineProps({
  modelValue: Boolean,
  title: { type: String, default: '' },
  /** Lowercase extensions, without the dot. Empty means every file. */
  extensions: { type: Array, default: () => [] },
  /** Folder to open on, usually the one holding the document being edited. */
  initialPath: { type: String, default: '' },
  elevated: Boolean,
  /** Answer with the folder being looked at rather than with a file. */
  chooseFolder: Boolean,
});

const emit = defineEmits(['update:modelValue', 'select']);
const { t } = useI18n();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const { items, isLoading, error, crumbs, navigate, fullPath, currentPath } = useStorageBrowser();

const accepted = computed(() => new Set(props.extensions.map((ext) => String(ext).toLowerCase())));

const entries = computed(() =>
  items.value.filter((item) => {
    if (item.kind === 'directory') return true;
    if (props.chooseFolder) return false;
    if (accepted.value.size === 0) return true;
    return accepted.value.has(String(item.kind || '').toLowerCase());
  })
);

/** The top of the list holds the volumes, and is not a folder of its own. */
const canChooseHere = computed(
  () => !isLoading.value && !error.value && Boolean(currentPath.value)
);

const chooseCurrentFolder = () => {
  if (!canChooseHere.value) return;
  emit('select', currentPath.value);
  isOpen.value = false;
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

    <div class="flex max-h-full min-h-0 flex-col gap-3">
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
        class="min-h-40 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-zinc-700"
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
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-zinc-800"
          @click="isOpen = false"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          v-if="chooseFolder"
          type="button"
          data-testid="storage-picker-choose-folder"
          class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          :disabled="!canChooseHere"
          @click="chooseCurrentFolder"
        >
          {{ t('storagePicker.chooseFolder') }}
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
