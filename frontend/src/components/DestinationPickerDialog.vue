<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderIcon, ClockIcon, StarIcon } from '@heroicons/vue/24/outline';
import ModalDialog from '@/components/ModalDialog.vue';
import { useStorageBrowser } from '@/composables/useStorageBrowser';
import { useFavoritesStore } from '@/stores/favorites';
import { useDestinationPicker } from '@/composables/useDestinationPicker';
import { fetchRecentDestinations, normalizePath } from '@/api';
import logger from '@/utils/logger';

/**
 * Choose where to move or copy something.
 *
 * Dragging onto a folder is the fast way to file something, but it is turned
 * off on touch devices — which leaves anyone on a tablet with no way to move a
 * file at all. This is that way, and it is built for the case that forced it:
 * large targets, no dragging, and the folders you actually use offered before
 * any browsing is needed.
 *
 * The three sections are ordered by how likely they are to hold the answer:
 * where you last put things, what you bookmarked, then the storage itself.
 */

const { t } = useI18n();
const favoritesStore = useFavoritesStore();
const picker = useDestinationPicker();
const { currentPath, items: entries, isLoading, error, crumbs, navigate } = useStorageBrowser();

// Closing without choosing has to settle the caller's promise, whichever way it
// happens — the Cancel button, the dialog's own dismiss, or the Escape key.
const isOpen = computed({
  get: () => picker.isOpen.value,
  set: (value) => {
    if (!value) {
      picker.isOpen.value = false;
      picker.dismiss();
    }
  },
});

const props = computed(() => ({
  mode: picker.mode.value,
  items: picker.items.value,
  initialPath: picker.initialPath.value,
}));

const recents = ref([]);

const folders = computed(() => entries.value.filter((entry) => entry.kind === 'directory'));

/** Paths of the folders being transferred, for the checks below. */
const movingPaths = computed(() =>
  props.value.items
    .filter((item) => item?.kind === 'directory')
    .map((item) => normalizePath(item.path ? `${item.path}/${item.name}` : item.name))
    .filter(Boolean)
);

/** Where everything currently sits — moving there again would do nothing. */
const sourcePath = computed(() => {
  const paths = new Set(props.value.items.map((item) => normalizePath(item?.path || '')));
  return paths.size === 1 ? [...paths][0] : null;
});

/**
 * Why a folder cannot be the destination, or '' when it can.
 *
 * The server refuses all of these too, but only once the transfer has been
 * asked for — by then the person has picked, confirmed, and watched it fail.
 */
const rejection = (path) => {
  const target = normalizePath(path);
  if (!target) return t('destinationPicker.rootRejected');

  for (const source of movingPaths.value) {
    if (target === source) return t('destinationPicker.itselfRejected');
    if (target.startsWith(`${source}/`)) return t('destinationPicker.descendantRejected');
  }

  if (props.value.mode === 'move' && sourcePath.value !== null && target === sourcePath.value) {
    return t('destinationPicker.alreadyThereRejected');
  }

  return '';
};

const currentRejection = computed(() => rejection(currentPath.value));
const canConfirm = computed(() => !isLoading.value && currentRejection.value === '');

const confirmLabel = computed(() =>
  props.value.mode === 'copy' ? t('destinationPicker.copyHere') : t('destinationPicker.moveHere')
);

const shortcuts = computed(() => {
  const seen = new Set();
  const rows = [];

  const add = (path, kind) => {
    const normalized = normalizePath(path);
    if (!normalized || seen.has(normalized) || rejection(normalized)) return;
    seen.add(normalized);
    rows.push({ path: normalized, kind, name: normalized.split('/').pop() || normalized });
  };

  recents.value.forEach((path) => add(path, 'recent'));
  favoritesStore.favorites.forEach((favorite) => add(favorite?.path, 'favorite'));
  return rows;
});

const confirm = () => {
  if (!canConfirm.value) return;
  picker.choose(normalizePath(currentPath.value));
};

const loadRecents = async () => {
  try {
    recents.value = await fetchRecentDestinations();
  } catch (recentsError) {
    // Browsing still works without them; there is nothing to tell the user.
    logger.debug('Could not load recent destinations', recentsError);
    recents.value = [];
  }
};

watch(
  () => picker.isOpen.value,
  (opened) => {
    if (!opened) return;
    void navigate(props.value.initialPath || '');
    void loadRecents();
    void favoritesStore.ensureLoaded?.();
  },
  { immediate: true }
);
</script>

<template>
  <ModalDialog v-model="isOpen">
    <template #title>
      {{
        props.mode === 'copy' ? t('destinationPicker.copyTitle') : t('destinationPicker.moveTitle')
      }}
    </template>

    <div class="flex flex-col gap-3">
      <div v-if="shortcuts.length" class="flex flex-col gap-1">
        <ul class="flex flex-col gap-1">
          <li v-for="shortcut in shortcuts" :key="`${shortcut.kind}:${shortcut.path}`">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-neutral-100 dark:hover:bg-zinc-800"
              @click="navigate(shortcut.path)"
            >
              <ClockIcon
                v-if="shortcut.kind === 'recent'"
                class="h-4 w-4 shrink-0 text-neutral-400"
                aria-hidden="true"
              />
              <StarIcon v-else class="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span class="truncate">{{ shortcut.name }}</span>
              <span class="truncate text-xs text-neutral-500 dark:text-neutral-400">
                {{ shortcut.path }}
              </span>
            </button>
          </li>
        </ul>
      </div>

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
        class="h-64 overflow-y-auto rounded-lg border border-neutral-200 dark:border-zinc-700"
        role="listbox"
      >
        <p v-if="isLoading" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ t('common.loadingEllipsis') }}
        </p>
        <p v-else-if="error" class="p-4 text-red-600 dark:text-red-400">{{ error }}</p>
        <p v-else-if="folders.length === 0" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ t('destinationPicker.noFolders') }}
        </p>
        <ul v-else class="divide-y divide-neutral-100 dark:divide-zinc-800">
          <li v-for="folder in folders" :key="`${folder.path}/${folder.name}`">
            <button
              type="button"
              role="option"
              :aria-selected="false"
              class="flex w-full items-center gap-2 px-3 py-3 text-left hover:bg-neutral-100 dark:hover:bg-zinc-800"
              @click="navigate(folder.path ? `${folder.path}/${folder.name}` : folder.name)"
            >
              <FolderIcon class="h-4 w-4 shrink-0 text-blue-500" aria-hidden="true" />
              <span class="truncate">{{ folder.name }}</span>
            </button>
          </li>
        </ul>
      </div>

      <p v-if="currentRejection" class="text-xs text-amber-600 dark:text-amber-400">
        {{ currentRejection }}
      </p>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-zinc-800"
          @click="isOpen = false"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canConfirm"
          @click="confirm"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </ModalDialog>
</template>
