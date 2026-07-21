<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { offset, flip, shift, useFloating, autoUpdate } from '@floating-ui/vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { explorerContextMenuSymbol } from '@/composables/contextMenu';
import { useFileStore } from '@/stores/fileStore';
import { useSelection } from '@/composables/itemSelection';
import { useFileActions } from '@/composables/fileActions';
import { useInfoPanelStore } from '@/stores/infoPanel';
import { normalizePath } from '@/api';
import { modKeyLabel, deleteKeyLabel } from '@/utils/keyboard';
import { useDeleteConfirm } from '@/composables/useDeleteConfirm';
import ModalDialog from '@/components/ModalDialog.vue';
import ShareDialog from '@/components/ShareDialog.vue';
import { useFavoritesStore } from '@/stores/favorites';
import {
  StarIcon as StarOutline,
  DocumentTextIcon,
  CommandLineIcon,
  ArrowDownTrayIcon,
  ShareIcon,
  ArchiveBoxArrowDownIcon,
  ArrowUpOnSquareIcon,
} from '@heroicons/vue/24/outline';
import { StarIcon as StarSolid } from '@heroicons/vue/24/solid';
import { useFavoriteEditor } from '@/composables/useFavoriteEditor';
import { useTerminalStore } from '@/stores/terminal';
import { useFeaturesStore } from '@/stores/features';
import { isTerminalExtension } from '@/config/terminal';
// Icons
import {
  CreateNewFolderRound,
  InsertDriveFileRound,
  ContentCutRound,
  ContentCopyRound,
  ContentPasteRound,
  DriveFileRenameOutlineRound,
  InfoRound,
  DeleteRound,
} from '@vicons/material';

const fileStore = useFileStore();
const infoPanel = useInfoPanelStore();
const { clearSelection } = useSelection();
const favoritesStore = useFavoritesStore();
const { openEditorForFavorite } = useFavoriteEditor();
const terminalStore = useTerminalStore();
const featuresStore = useFeaturesStore();
const router = useRouter();

const isOpen = ref(false);
const pointer = ref({ x: 0, y: 0 });
const contextKind = ref('background'); // background | file | directory
const targetItem = ref(null);
const isMutatingFavorite = ref(false);

const referenceRef = ref(null);
const floatingRef = ref(null);

const { x, y, strategy, update } = useFloating(referenceRef, floatingRef, {
  placement: 'right-start',
  strategy: 'fixed',
  middleware: [offset(4), flip(), shift()],
  // Position as soon as the menu mounts (and keep it pinned) so it appears
  // instantly at the cursor instead of flashing at the top-left for a frame.
  whileElementsMounted: autoUpdate,
});

const floatingStyles = computed(() => ({
  position: strategy.value,
  // Until floating-ui computes (x/y null on the very first frame), fall back to
  // the cursor position so the menu paints AT the cursor immediately — no visible
  // delay or top-left flash — then gets refined (offset/flip/shift) in place.
  left: `${Math.max(x.value ?? pointer.value.x, 0)}px`,
  top: `${Math.max(y.value ?? pointer.value.y, 0)}px`,
  zIndex: 1600,
}));

const referenceStyles = computed(() => ({
  position: 'fixed',
  left: `${pointer.value.x}px`,
  top: `${pointer.value.y}px`,
}));

const actions = useFileActions();
const { t } = useI18n();
const selectedItems = actions.selectedItems;
const hasSelection = actions.hasSelection;
const primaryItem = actions.primaryItem;
const isSingleItemSelected = actions.isSingleItemSelected;
const canRename = actions.canRename;
const locationCanWrite = actions.locationCanWrite;
const locationCanCreateFolder = actions.locationCanCreateFolder;
const locationCanCreateFile = actions.locationCanCreateFile;
const locationCanUpload = actions.locationCanUpload;
const locationCanDelete = actions.locationCanDelete;
const canAcceptPasteHere = computed(
  () => locationCanCreateFolder.value || locationCanCreateFile.value
);
const isShareDialogOpen = ref(false);
const itemToShare = ref(null);

const isVolumesView = computed(() => {
  const p = normalizePath(fileStore.getCurrentPath || '');
  return !p || p.trim() === '';
});

const isShareView = computed(() => {
  const p = normalizePath(fileStore.getCurrentPath || '');
  return p.startsWith('share/');
});

const locationCanShare = computed(() => fileStore.currentPathData?.canShare ?? true);

const canShare = computed(
  () =>
    !isVolumesView.value &&
    !isShareView.value &&
    locationCanShare.value &&
    isSingleItemSelected.value &&
    Boolean(primaryItem.value) &&
    primaryItem.value?.kind !== 'volume'
);

const deleteDialogTitle = computed(() => {
  const count = pendingDeleteItems.value.length;
  if (count === 1 && pendingDeleteItems.value[0]) {
    return t('context.deleteTitle.single', { name: pendingDeleteItems.value[0].name });
  }
  if (count > 1) {
    return t('context.deleteTitle.multiple', { count });
  }
  return t('context.deleteTitle.generic');
});

const deleteDialogMessage = computed(() => {
  const count = pendingDeleteItems.value.length;
  if (count === 1 && pendingDeleteItems.value[0]) {
    return t('context.deleteMessage.single', { name: pendingDeleteItems.value[0].name });
  }
  if (count > 1) {
    return t('context.deleteMessage.multiple', { count });
  }
  return t('context.deleteMessage.generic');
});

const {
  isDeleteConfirmOpen,
  isDeleting,
  isLoadingDeleteImpact,
  deleteImpact,
  deleteImpactError,
  pendingDeleteItems,
  requestDelete,
  confirmDelete,
  closeDeleteConfirm,
} = useDeleteConfirm();

const deleteShareImpactMessage = computed(() => {
  const count = Number(deleteImpact.value?.shareCount || 0);
  if (count <= 0) return '';
  return t('context.deleteLinkedShares', { count });
});

const deleteOnlyOfficeActivityMessage = computed(() => {
  const activeItems = pendingDeleteItems.value.filter((item) => item?.onlyofficeActivity?.active);
  if (activeItems.length === 0) return '';
  const names = activeItems
    .slice(0, 2)
    .map((item) => item.name)
    .join(', ');
  const remaining = activeItems.length - Math.min(activeItems.length, 2);
  const subject = `${names}${remaining > 0 ? ` et ${remaining} autre(s)` : ''}`;
  return `${subject} ${activeItems.length > 1 ? 'sont ouverts' : 'est ouvert'} dans OnlyOffice. La suppression reste possible, mais une modification non enregistrée peut être perdue.`;
});

const closeMenu = () => {
  isOpen.value = false;
};

const clearTextSelection = () => {
  window.getSelection?.()?.removeAllRanges?.();
};

const getItemKey = (item) => {
  if (!item || !item.name) return '';
  const parent = normalizePath(item.path || '');
  return `${parent}::${item.name}`;
};

const ensureItemInSelection = (item) => {
  if (!item) return;
  const key = getItemKey(item);
  const alreadySelected = fileStore.selectedItemKeys.has(key);

  if (alreadySelected) {
    return;
  }

  const match = fileStore.getCurrentPathItems.find((candidate) => getItemKey(candidate) === key);

  fileStore.selectedItems = match ? [match] : [item];
};

const openMenuAt = (event, kind, item = null) => {
  if (!event) return;
  clearTextSelection();
  const clientX = event.clientX ?? 0;
  const clientY = event.clientY ?? 0;

  pointer.value = { x: clientX, y: clientY };
  contextKind.value = kind;
  targetItem.value = item;
  isOpen.value = true;
};

const openItemMenu = (event, item) => {
  if (!event || !item) return;
  event.preventDefault?.();
  ensureItemInSelection(item);
  openMenuAt(event, item.kind === 'directory' ? 'directory' : 'file', item);
};

const openBackgroundMenu = (event) => {
  if (!event) return;
  event.preventDefault?.();
  openMenuAt(event, 'background');
};

const resolveItemPath = (item) => {
  if (!item || !item.name) {
    return normalizePath(fileStore.getCurrentPath || '');
  }
  return actions.resolveItemPath(item);
};

const runCut = () => actions.runCut();
const runCopy = () => actions.runCopy();
const runPasteIntoDirectory = async () => {
  if (!actions.canPaste.value) return;
  const destination = resolveItemPath(targetItem.value);
  await actions.runPasteToDestination(destination);
};

const runPasteIntoCurrent = async () => {
  if (!actions.canPaste.value) return;
  await actions.runPasteIntoCurrent();
};

const runCreateFile = async () => {
  await fileStore.createFile();
};

const runCreateFolder = async () => {
  await fileStore.createFolder();
};

const runRename = () => actions.runRename();

const runDownload = () => actions.runDownload();

const runExtractArchive = () => actions.runExtractArchive();
const runExtractArchiveIntoCurrentFolder = () => actions.runExtractArchiveIntoCurrentFolder();
const runCompressToZip = () => actions.runCompressToZip();

const runShare = () => {
  if (!canShare.value) return;
  itemToShare.value = primaryItem.value;
  isShareDialogOpen.value = true;
};

// requestDelete and confirmDelete are provided by useDeleteConfirm()

const runGetInfo = () => {
  if (!primaryItem.value) return;
  // Open right-side info panel with selected item
  infoPanel.open(primaryItem.value);
};

const runOpenWithEditor = () => {
  if (!primaryItem.value) return;
  const item = primaryItem.value;
  const basePath = item.path ? `${item.path}/${item.name}` : item.name;
  const fileToEdit = basePath.replace(/^\/+/, '');
  // Encode each segment for editor path
  const encodedPath = fileToEdit.split('/').map(encodeURIComponent).join('/');
  router.push({ path: `/editor/${encodedPath}` });
};

const getItemExtension = (item) => {
  const name = String(item?.name || '');
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0 && lastDot < name.length - 1) {
    return name.slice(lastDot + 1).toLowerCase();
  }

  const kind = String(item?.kind || '').toLowerCase();
  return kind && kind !== 'file' && kind !== 'directory' && kind !== 'volume' ? kind : '';
};

const shellEscape = (value) => String(value).replace(/([^A-Za-z0-9_@%+=:,./-])/g, '\\$1');

const buildTerminalInputForItem = (item) => {
  const name = String(item?.name || '').trim();
  if (!name) return '';

  return shellEscape(`./${name}`);
};

const canOpenWithTerminal = computed(() => {
  if (!featuresStore.terminalEnabled || contextKind.value !== 'file' || !primaryItem.value) {
    return false;
  }

  return isTerminalExtension(getItemExtension(primaryItem.value));
});

const runOpenWithTerminal = () => {
  if (!canOpenWithTerminal.value || !primaryItem.value) return;
  const item = primaryItem.value;
  const parentPath = normalizePath(item.path || fileStore.getCurrentPath || '');
  const initialInput = buildTerminalInputForItem(item);
  terminalStore.open(parentPath, initialInput);
};

// Favorites support
const selectedDirectoryPath = computed(() => {
  if (contextKind.value !== 'directory') return null;
  const item = targetItem.value;
  if (!item || item.kind !== 'directory') return null;
  return normalizePath(actions.resolveItemPath(item));
});

const isFavoriteDirectory = computed(() => {
  const path = selectedDirectoryPath.value;
  if (!path) return false;
  return favoritesStore.isFavorite(path);
});

const currentDirectoryPath = computed(() => normalizePath(fileStore.getCurrentPath || ''));
const isFavoriteCurrentDirectory = computed(() => {
  const path = currentDirectoryPath.value;
  if (!path) return false;
  return favoritesStore.isFavorite(path);
});

const runToggleFavoriteForDirectory = async () => {
  const path = selectedDirectoryPath.value;
  if (!path || isMutatingFavorite.value) return;
  isMutatingFavorite.value = true;
  try {
    if (isFavoriteDirectory.value) {
      await favoritesStore.removeFavorite(path);
    } else {
      const favorite = await favoritesStore.addFavorite({ path });
      if (favorite) {
        openEditorForFavorite(favorite);
      }
    }
  } finally {
    isMutatingFavorite.value = false;
  }
};

const runToggleFavoriteForCurrent = async () => {
  const path = currentDirectoryPath.value;
  if (!path || isMutatingFavorite.value) return;
  isMutatingFavorite.value = true;
  try {
    if (isFavoriteCurrentDirectory.value) {
      await favoritesStore.removeFavorite(path);
    } else {
      const favorite = await favoritesStore.addFavorite({ path });
      if (favorite) {
        openEditorForFavorite(favorite);
      }
    }
  } finally {
    isMutatingFavorite.value = false;
  }
};

// Inline quick-actions menu: run a single action against a specific item without
// opening the full right-click menu. Reuses this component's action machinery
// (share/delete dialogs, favorites) so there is a single implementation. The item
// is selected first so the selection-based run functions target it.
const copyTextToClipboard = async (text) => {
  try {
    await navigator.clipboard?.writeText?.(String(text || ''));
  } catch {
    // Clipboard unavailable (insecure context / denied) — ignore.
  }
};

const toggleFavoriteForItem = async (item) => {
  if (!item || item.kind !== 'directory' || isMutatingFavorite.value) return;
  const path = normalizePath(actions.resolveItemPath(item));
  if (!path) return;
  isMutatingFavorite.value = true;
  try {
    if (favoritesStore.isFavorite(path)) {
      await favoritesStore.removeFavorite(path);
    } else {
      const favorite = await favoritesStore.addFavorite({ path });
      if (favorite) openEditorForFavorite(favorite);
    }
  } finally {
    isMutatingFavorite.value = false;
  }
};

const quickActionAvailable = (item, id) => {
  if (!item) return false;
  if (item.kind === 'volume') return id === 'info' || id === 'copyName';
  const isDir = item.kind === 'directory';
  switch (id) {
    case 'info':
    case 'copyName':
    case 'copyPath':
    case 'copy':
    case 'download':
      return true;
    case 'cut':
      return locationCanWrite.value && locationCanDelete.value;
    case 'rename':
      return locationCanWrite.value;
    case 'share':
      return !isVolumesView.value && !isShareView.value && locationCanShare.value;
    case 'compress':
      return locationCanWrite.value;
    case 'favorite':
      return isDir;
    case 'delete':
      return locationCanDelete.value;
    default:
      return false;
  }
};

const runQuickAction = async (item, id) => {
  if (!item) return;
  ensureItemInSelection(item);
  switch (id) {
    case 'info':
      runGetInfo();
      break;
    case 'download':
      runDownload();
      break;
    case 'copyName':
      await copyTextToClipboard(item.name || '');
      break;
    case 'copyPath':
      await copyTextToClipboard(actions.resolveItemPath(item));
      break;
    case 'copy':
      runCopy();
      break;
    case 'cut':
      runCut();
      break;
    case 'rename':
      runRename();
      break;
    case 'share':
      runShare();
      break;
    case 'compress':
      runCompressToZip();
      break;
    case 'favorite':
      await toggleFavoriteForItem(item);
      break;
    case 'delete':
      requestDelete();
      break;
    default:
      break;
  }
};

// Build grouped, themed menu sections with icons + shortcuts
const menuSections = computed(() => {
  if (!isOpen.value) return [];

  const mk = (id, label, icon, run, opts = {}) => ({
    id,
    label,
    icon,
    run,
    disabled: Boolean(opts.disabled),
    shortcut: opts.shortcut || '',
    danger: Boolean(opts.danger),
  });

  if (contextKind.value === 'background') {
    const sections = [];
    sections.push([
      mk('get-info', t('context.getInfo'), InfoRound, runGetInfo, {
        disabled: !primaryItem.value,
      }),
    ]);
    sections.push([
      mk(
        'fav-current',
        isFavoriteCurrentDirectory.value
          ? t('context.removeFromFavorites')
          : t('context.addToFavorites'),
        isFavoriteCurrentDirectory.value ? StarSolid : StarOutline,
        runToggleFavoriteForCurrent,
        { disabled: !currentDirectoryPath.value || isMutatingFavorite.value }
      ),
    ]);

    const createItems = [];
    if (locationCanCreateFolder.value) {
      createItems.push(
        mk('new-folder', t('actions.newFolder'), CreateNewFolderRound, runCreateFolder)
      );
    }
    if (locationCanCreateFile.value) {
      createItems.push(mk('new-file', t('actions.newFile'), InsertDriveFileRound, runCreateFile));
    }
    if (createItems.length > 0) {
      sections.push(createItems);
    }

    if (canAcceptPasteHere.value) {
      sections.push([
        mk('paste', t('actions.paste'), ContentPasteRound, runPasteIntoCurrent, {
          disabled: !actions.canPaste.value,
          shortcut: `${modKeyLabel}V`,
        }),
      ]);
    }

    return sections;
  }

  const sections = [];
  sections.push([
    mk('get-info', t('context.getInfo'), InfoRound, runGetInfo, {
      disabled: !primaryItem.value,
    }),
  ]);

  // Add "Open with Editor" for files only
  if (contextKind.value === 'file') {
    const openSection = [
      mk('open-with-editor', t('context.openWithEditor'), DocumentTextIcon, runOpenWithEditor, {
        disabled: !primaryItem.value,
      }),
    ];

    if (canOpenWithTerminal.value) {
      openSection.push(
        mk(
          'open-with-terminal',
          t('context.openWithTerminal'),
          CommandLineIcon,
          runOpenWithTerminal,
          {
            disabled: !primaryItem.value,
          }
        )
      );
    }

    sections.push(openSection);
  }

  // Add download option
  sections.push([
    mk('download', t('actions.download'), ArrowDownTrayIcon, runDownload, {
      disabled: !hasSelection.value,
    }),
  ]);

  // Add archive actions
  if (!isVolumesView.value) {
    const archiveSection = [];

    if (actions.primaryItem.value && contextKind.value === 'file') {
      // Formats come from the server probe (zip, 7z, iso, rar, tar.gz…).
      if (actions.isArchiveSelected.value) {
        archiveSection.push(
          mk(
            'extract-archive',
            t('actions.extractArchive'),
            ArrowUpOnSquareIcon,
            runExtractArchive,
            {
              disabled: !actions.canExtractArchive.value,
            }
          )
        );
        archiveSection.push(
          mk(
            'extract-archive-current-folder',
            t('actions.extractArchiveIntoCurrentFolder'),
            ArrowUpOnSquareIcon,
            runExtractArchiveIntoCurrentFolder,
            {
              disabled: !actions.canExtractArchive.value,
            }
          )
        );
      }
    }

    if (hasSelection.value) {
      archiveSection.push(
        mk('compress-zip', t('actions.compressToZip'), ArchiveBoxArrowDownIcon, runCompressToZip, {
          disabled: !actions.canCompressToZip.value,
        })
      );
    }

    if (archiveSection.length) {
      sections.push(archiveSection);
    }
  }

  // Add share option (same availability rules as toolbar)
  if (!isVolumesView.value && !isShareView.value && locationCanShare.value) {
    sections.push([
      mk('share', t('share.shareSelectedItem'), ShareIcon, runShare, {
        disabled: !canShare.value,
      }),
    ]);
  }

  const clipboardSection = [];
  if (locationCanWrite.value && locationCanDelete.value) {
    clipboardSection.push(
      mk('cut', t('actions.cut'), ContentCutRound, runCut, {
        disabled: !actions.canCut.value,
        shortcut: `${modKeyLabel}X`,
      })
    );
  }
  clipboardSection.push(
    mk('copy', t('actions.copy'), ContentCopyRound, runCopy, {
      disabled: !actions.canCopy.value,
      shortcut: `${modKeyLabel}C`,
    })
  );
  if (contextKind.value === 'directory') {
    if (canAcceptPasteHere.value) {
      clipboardSection.push(
        mk('paste', t('actions.paste'), ContentPasteRound, runPasteIntoDirectory, {
          disabled: !actions.canPaste.value,
          shortcut: `${modKeyLabel}V`,
        })
      );
    }
  }
  if (clipboardSection.length) {
    sections.push(clipboardSection);
  }

  if (locationCanWrite.value) {
    sections.push([
      mk('rename', t('actions.rename'), DriveFileRenameOutlineRound, runRename, {
        disabled: !canRename.value,
        shortcut: 'F2',
      }),
    ]);
  }

  if (contextKind.value === 'directory') {
    sections.push([
      mk(
        'fav',
        isFavoriteDirectory.value ? t('context.removeFromFavorites') : t('context.addToFavorites'),
        isFavoriteDirectory.value ? StarSolid : StarOutline,
        runToggleFavoriteForDirectory,
        { disabled: !selectedDirectoryPath.value || isMutatingFavorite.value }
      ),
    ]);
  }

  if (locationCanDelete.value) {
    sections.push([
      mk('delete', t('common.delete'), DeleteRound, requestDelete, {
        disabled: !actions.canDelete.value,
        danger: true,
        shortcut: deleteKeyLabel,
      }),
    ]);
  }

  return sections;
});

const runAction = async (action) => {
  if (!action || action.disabled) return;
  closeMenu();
  try {
    await action.run();
  } catch (error) {
    console.error(`Context menu action "${action.id}" failed`, error);
  }
};

const handleGlobalPointerDown = (event) => {
  if (!isOpen.value) return;
  const menu = floatingRef.value;
  if (menu && (menu === event.target || menu.contains(event.target))) {
    return;
  }
  closeMenu();
};

const handleGlobalKeydown = (event) => {
  if (event.key === 'Escape') {
    closeMenu();
  }
};

// `whileElementsMounted: autoUpdate` positions the menu the moment it opens, so no
// explicit reposition-on-open is needed. Reopening at a new cursor position while
// the menu is already mounted still needs a nudge.
watch(
  pointer,
  async () => {
    if (!isOpen.value) return;
    await nextTick();
    update();
  },
  { deep: true }
);

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown);
  window.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown);
  window.removeEventListener('keydown', handleGlobalKeydown);
});

provide(explorerContextMenuSymbol, {
  openItemMenu,
  openBackgroundMenu,
  closeMenu,
  clearSelection,
  runQuickAction,
  quickActionAvailable,
});
</script>

<template>
  <slot />

  <div
    v-if="isOpen"
    ref="referenceRef"
    class="pointer-events-none h-0 w-0"
    :style="referenceStyles"
  />

  <teleport to="body">
    <div
      v-if="isOpen"
      ref="floatingRef"
      :style="floatingStyles"
      class="min-w-[220px] rounded-xl border border-zinc-200 bg-white p-1.5 text-sm text-zinc-800 shadow-2xl dark:border-white/10 dark:bg-neutral-800 dark:text-zinc-200"
      @contextmenu.prevent
      @click.stop
    >
      <div v-for="(section, sIdx) in menuSections" :key="`section-${sIdx}`" class="flex flex-col">
        <button
          v-for="action in section"
          :key="action.id"
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50"
          :class="[
            action.danger
              ? 'text-red-600 hover:bg-red-500/20 dark:text-red-500 dark:hover:bg-red-500/20'
              : 'hover:bg-zinc-500/20 dark:hover:bg-zinc-400/20',
          ]"
          :disabled="action.disabled"
          @click.stop="runAction(action)"
        >
          <component :is="action.icon" class="w-4 h-4 opacity-80" />
          <p class="flex-1 font-medium">{{ action.label }}</p>
          <span v-if="action.shortcut" class="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{{
            action.shortcut
          }}</span>
          <span v-if="action.disabled" class="sr-only">{{ $t('common.disabled') }}</span>
        </button>

        <div
          v-if="sIdx < menuSections.length - 1"
          class="my-1 h-px bg-zinc-300/50 dark:bg-zinc-700/50"
        />
      </div>
    </div>
  </teleport>

  <ModalDialog :model-value="isDeleteConfirmOpen" @update:model-value="closeDeleteConfirm">
    <template #title>{{ deleteDialogTitle }}</template>
    <p class="mb-6 text-base text-zinc-700 dark:text-zinc-200">
      {{ deleteDialogMessage }}
    </p>
    <p v-if="isLoadingDeleteImpact" class="-mt-3 mb-6 text-sm text-zinc-500 dark:text-zinc-400">
      {{ $t('context.checkingDeleteImpact') }}
    </p>
    <p
      v-if="deleteOnlyOfficeActivityMessage"
      class="-mt-3 mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-100"
    >
      {{ deleteOnlyOfficeActivityMessage }}
    </p>
    <p
      v-if="!isLoadingDeleteImpact && deleteShareImpactMessage"
      class="-mt-3 mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-100"
    >
      {{ deleteShareImpactMessage }}
    </p>
    <p v-else-if="deleteImpactError" class="-mt-3 mb-6 text-sm text-amber-700 dark:text-amber-300">
      {{ $t('context.deleteImpactUnavailable') }}
    </p>
    <div class="flex justify-end gap-3">
      <button
        type="button"
        class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 active:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:active:bg-zinc-600"
        @click="closeDeleteConfirm"
        :disabled="isDeleting"
      >
        {{ $t('common.cancel') }}
      </button>
      <button
        type="button"
        class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-400"
        @click="confirmDelete"
        :disabled="isDeleting"
      >
        <span v-if="isDeleting">{{ $t('common.deleting') }}</span>
        <span v-else>{{ $t('common.delete') }}</span>
      </button>
    </div>
  </ModalDialog>

  <ShareDialog v-model="isShareDialogOpen" :item="itemToShare" />
</template>
