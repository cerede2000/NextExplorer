<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderIcon, ClockIcon, DocumentIcon, StarIcon } from '@heroicons/vue/24/outline';
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

/**
 * In file mode the answer is a file — the one an earlier version is put over —
 * so files are listed beside the folders, and choosing one selects it.
 */
const isFileMode = computed(() => props.value.mode === 'file');
const selectedFile = ref('');
const entryPath = (entry) =>
  normalizePath(entry?.path ? `${entry.path}/${entry.name}` : entry?.name || '');
const listed = computed(() =>
  isFileMode.value ? entries.value.filter((entry) => entry.kind !== 'volume') : folders.value
);
const sourceFile = computed(() => (props.value.items[0] ? entryPath(props.value.items[0]) : ''));
watch(currentPath, () => {
  selectedFile.value = '';
});

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

const fileRejection = () => {
  if (!selectedFile.value) return t('destinationPicker.fileRequired');
  if (selectedFile.value === sourceFile.value) return t('destinationPicker.sameFileRejected');
  return '';
};

const currentRejection = computed(() =>
  isFileMode.value ? fileRejection() : rejection(currentPath.value)
);
const canConfirm = computed(() => !isLoading.value && currentRejection.value === '');

const LABELS = {
  copy: { title: 'destinationPicker.copyTitle', confirm: 'destinationPicker.copyHere' },
  move: { title: 'destinationPicker.moveTitle', confirm: 'destinationPicker.moveHere' },
  // Out of the trash: nothing is being taken from a folder, so nothing is
  // "already there" either.
  restore: { title: 'destinationPicker.restoreTitle', confirm: 'destinationPicker.restoreHere' },
  // An earlier version of a file taken out as a copy, or put over another file.
  'version-copy': {
    title: 'destinationPicker.versionCopyTitle',
    confirm: 'destinationPicker.versionCopyHere',
  },
  file: { title: 'destinationPicker.replaceTitle', confirm: 'destinationPicker.replaceHere' },
  // Out of an archive and onto the volume: nothing is leaving a folder here
  // either, so the same reading as a restore.
  extract: { title: 'destinationPicker.extractTitle', confirm: 'destinationPicker.extractHere' },
};
const labels = computed(() => LABELS[props.value.mode] || LABELS.move);
const title = computed(() => t(labels.value.title));
const confirmLabel = computed(() => t(labels.value.confirm));

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
  picker.choose(isFileMode.value ? selectedFile.value : normalizePath(currentPath.value));
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
  <!-- Above the Versions panel, which asks for these two over an open editor too. -->
  <!--
    Raised above what asked for it whenever that is itself a window: the
    versions panel, the editor, and the archive panel all sit above the page,
    and a dialog at the page's own level would open behind them.
  -->
  <ModalDialog
    v-model="isOpen"
    :elevated="['version-copy', 'file', 'extract'].includes(props.mode)"
  >
    <template #title>{{ title }}</template>

    <div class="flex max-h-full min-h-0 flex-col gap-3">
      <!--
        Favourites and recent destinations, capped. Ten of them pushed the
        folder list and the buttons off the bottom of the screen, on a dialog
        that had nowhere to scroll: what is above the list has to give way to
        it, not the other way round.
      -->
      <div v-if="shortcuts.length" class="flex max-h-44 shrink-0 flex-col gap-1 overflow-y-auto">
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

      <!--
        The folder list takes what is left rather than a fixed height: on a
        short screen it shrinks instead of pushing the buttons out of reach,
        and on a tall one it fills.
      -->
      <div
        class="min-h-40 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-zinc-700"
        role="listbox"
      >
        <p v-if="isLoading" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ t('common.loadingEllipsis') }}
        </p>
        <p v-else-if="error" class="p-4 text-red-600 dark:text-red-400">{{ error }}</p>
        <p v-else-if="listed.length === 0" class="p-4 text-neutral-500 dark:text-neutral-400">
          {{ isFileMode ? t('destinationPicker.nothingHere') : t('destinationPicker.noFolders') }}
        </p>
        <ul v-else class="divide-y divide-neutral-100 dark:divide-zinc-800">
          <li v-for="entry in listed" :key="`${entry.path}/${entry.name}`">
            <button
              v-if="entry.kind === 'directory'"
              type="button"
              role="option"
              :aria-selected="false"
              class="flex w-full items-center gap-2 px-3 py-3 text-left hover:bg-neutral-100 dark:hover:bg-zinc-800"
              @click="navigate(entry.path ? `${entry.path}/${entry.name}` : entry.name)"
            >
              <FolderIcon class="h-4 w-4 shrink-0 text-blue-500" aria-hidden="true" />
              <span class="truncate">{{ entry.name }}</span>
            </button>
            <button
              v-else
              type="button"
              role="option"
              :aria-selected="selectedFile === entryPath(entry)"
              data-test="destination-picker-file"
              class="flex w-full items-center gap-2 px-3 py-3 text-left hover:bg-neutral-100 dark:hover:bg-zinc-800"
              :class="selectedFile === entryPath(entry) ? 'bg-blue-50 dark:bg-blue-500/15' : ''"
              @click="selectedFile = entryPath(entry)"
            >
              <DocumentIcon class="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
              <span class="truncate">{{ entry.name }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-3">
        <p v-if="currentRejection" class="min-w-0 text-xs text-amber-600 dark:text-amber-400">
          {{ currentRejection }}
        </p>
        <span v-else></span>
        <div class="flex shrink-0 justify-end gap-2">
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
    </template>
  </ModalDialog>
</template>
