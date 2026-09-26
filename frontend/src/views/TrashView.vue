<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  FolderOpenIcon,
  MapPinIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import FileIcon from '@/icons/FileIcon.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import TrashContextMenu from '@/components/TrashContextMenu.vue';
import {
  deleteTrashItems,
  emptyTrash,
  getTrash,
  getTrashEntries,
  restoreTrashEntries,
  restoreTrashItems,
} from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { formatBytes, formatLocalDateTime } from '@/utils';
import { folderRoute } from '@/utils/folderRoute';
import { isEditableExtension } from '@/config/editor';

/**
 * The trash: what this person deleted, and what came from their own folder or
 * shares — everything, for an administrator.
 *
 * The server decides who sees what and who may restore where; this screen
 * says what happened to each request, including the ones it refused, so an
 * item that could not go back never just stays in the list without a word.
 *
 * A deleted folder can be opened, and what is inside it restored on its own:
 * each entry goes back to its place inside the folder, and the rest stays in
 * the trash. Which folder is open, and where inside it, is kept in the address,
 * so going back and reloading land where they should.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GRID_COLS =
  'grid-cols-[28px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_90px_36px]';
const ENTRY_GRID_COLS = 'grid-cols-[28px_minmax(0,4fr)_minmax(0,1.5fr)_90px]';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const notifications = useNotificationsStore();

const items = ref([]);
const enabled = ref(true);
const retentionDays = ref(null);
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const selectedIds = ref(new Set());
const pendingConfirm = ref(null);

const load = async () => {
  loading.value = true;
  error.value = '';
  try {
    const response = await getTrash();
    items.value = Array.isArray(response?.items) ? response.items : [];
    enabled.value = response?.enabled !== false;
    retentionDays.value = Number.isFinite(response?.retentionDays) ? response.retentionDays : null;
    const present = new Set(items.value.map((item) => item.id));
    selectedIds.value = new Set([...selectedIds.value].filter((id) => present.has(id)));
  } catch (err) {
    error.value = err?.message || t('trash.errors.load');
  } finally {
    loading.value = false;
  }
};

const selectedCount = computed(() => selectedIds.value.size);
const allSelected = computed(
  () => items.value.length > 0 && selectedIds.value.size === items.value.length
);

const toggle = (item) => {
  const next = new Set(selectedIds.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  selectedIds.value = next;
};

const toggleAll = () => {
  selectedIds.value = allSelected.value ? new Set() : new Set(items.value.map((item) => item.id));
};

const iconItem = (item) => {
  const parts = item.name.split('.');
  return {
    kind:
      item.kind === 'directory'
        ? 'directory'
        : parts.length > 1
          ? parts.pop().toLowerCase()
          : 'file',
    name: item.name,
    thumbnail: null,
    supportsThumbnail: false,
  };
};

const subtitle = computed(() =>
  Number.isFinite(retentionDays.value)
    ? t('trash.subtitle', { count: retentionDays.value }, retentionDays.value)
    : ''
);

const locationLabel = (item) => {
  const location = item.location;
  if (!location) return t('trash.location.unknown');
  const base = location.kind === 'personal' ? t('trash.location.personal') : location.name;
  return location.parent ? `${base} / ${location.parent}` : base;
};

const deletedByLabel = (item) => {
  if (item.deletedBy?.isYou) return t('trash.deletedBy.you');
  if (item.deletedBy?.label === 'share-link') return t('trash.deletedBy.shareLink');
  return item.deletedBy?.label || t('trash.deletedBy.unknown');
};

const daysLeft = (item) =>
  Math.max(0, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / DAY_MS));

const expiresLabel = (item) => {
  const days = daysLeft(item);
  return days === 0 ? t('trash.expiresToday') : t('trash.expiresIn', { count: days }, days);
};

// Inside a deleted folder.

const folderId = computed(() =>
  typeof route.query?.item === 'string' && route.query.item ? route.query.item : null
);
const folderPath = computed(() => (typeof route.query?.path === 'string' ? route.query.path : ''));
const folder = ref(null);
const folderLoading = ref(false);
const folderError = ref('');
const selectedEntries = ref(new Set());
let folderRequest = 0;

const joinPath = (parent, name) => (parent ? `${parent}/${name}` : name);

const loadFolder = async () => {
  const id = folderId.value;
  const request = ++folderRequest;
  if (!id) {
    folder.value = null;
    folderError.value = '';
    folderLoading.value = false;
    return;
  }
  folderLoading.value = true;
  folderError.value = '';
  try {
    const response = await getTrashEntries(id, folderPath.value);
    // Somewhere else was opened meanwhile: that answer is the one to show.
    if (request !== folderRequest) return;
    folder.value = {
      item: response?.item || null,
      entries: Array.isArray(response?.entries) ? response.entries : [],
    };
    const present = new Set(folder.value.entries.map((entry) => entry.name));
    selectedEntries.value = new Set([...selectedEntries.value].filter((name) => present.has(name)));
  } catch (err) {
    if (request !== folderRequest) return;
    folder.value = null;
    folderError.value = err?.message || t('trash.errors.loadFolder');
  } finally {
    if (request === folderRequest) folderLoading.value = false;
  }
};

watch(
  [folderId, folderPath],
  () => {
    folder.value = null;
    selectedEntries.value = new Set();
    loadFolder();
  },
  { immediate: true }
);

const crumbs = computed(() => {
  const item = folder.value?.item;
  if (!item) return [];
  const segments = folderPath.value ? folderPath.value.split('/') : [];
  return [
    { label: item.name, path: '' },
    ...segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join('/'),
    })),
  ];
});

const folderInfo = computed(() => {
  const item = folder.value?.item;
  if (!item) return '';
  return t('trash.browse.deletedFrom', {
    location: locationLabel(item),
    date: formatLocalDateTime(item.deletedAt),
  });
});

const entries = computed(() => folder.value?.entries || []);
const selectedEntryCount = computed(() => selectedEntries.value.size);
const allEntriesSelected = computed(
  () => entries.value.length > 0 && selectedEntries.value.size === entries.value.length
);

const toggleEntry = (entry) => {
  const next = new Set(selectedEntries.value);
  if (next.has(entry.name)) next.delete(entry.name);
  else next.add(entry.name);
  selectedEntries.value = next;
};

const toggleAllEntries = () => {
  selectedEntries.value = allEntriesSelected.value
    ? new Set()
    : new Set(entries.value.map((entry) => entry.name));
};

const trashRoute = (query = {}) => ({ name: 'Trash', query });

const openFolder = (item) => router.push(trashRoute({ item: item.id }));

const openEntry = (entry) =>
  router.push(trashRoute({ item: folderId.value, path: joinPath(folderPath.value, entry.name) }));

const goToCrumb = (crumb) =>
  router.push(
    trashRoute(crumb.path ? { item: folderId.value, path: crumb.path } : { item: folderId.value })
  );

const leaveFolder = () => router.push(trashRoute());

const REASONS = {
  forbidden: 'forbidden',
  blocked: 'blocked',
  unavailable: 'unavailable',
  busy: 'busy',
  lost: 'lost',
  'not-found': 'notFound',
  missing: 'notFound',
};

/** A reason the server named, where it says more than the status does. */
const REASON_TEXTS = {
  destination: 'destinationForbidden',
  'invalid-destination': 'invalidDestination',
};

const reasonText = (result) =>
  t(`trash.reasons.${REASON_TEXTS[result.reason] || REASONS[result.status] || 'unknown'}`);

const describeFailures = (failed) =>
  failed.map((result) => `${result.name || result.id}: ${reasonText(result)}`).join('\n');

const runBusy = async (work) => {
  busy.value = true;
  try {
    await work();
  } catch (err) {
    notifications.addNotification({
      type: 'error',
      heading: t('trash.errors.action'),
      body: err?.message || '',
    });
  } finally {
    busy.value = false;
    await load();
    if (folderId.value) await loadFolder();
  }
};

/** Say what came back, where, under which name, and what did not and why. */
const reportRestored = (results) => {
  const restored = results.filter((result) => result.status === 'restored');
  const failed = results.filter((result) => result.status !== 'restored');

  if (restored.length) {
    const lines = restored
      .filter((result) => result.renamed)
      .map((result) =>
        t('trash.results.renamed', { name: result.name, newName: result.restoredName })
      );
    if (restored.length === 1 && restored[0].path) {
      lines.unshift(t('trash.results.restoredTo', { path: restored[0].path }));
    }
    const links = (field) =>
      restored.reduce((total, result) => total + (Number(result[field]) || 0), 0);
    const linksBack = links('sharesRestored');
    const linksGone = links('sharesDropped');
    if (linksBack) lines.push(t('trash.shares.restored', { count: linksBack }, linksBack));
    if (linksGone) lines.push(t('trash.shares.dropped', { count: linksGone }, linksGone));
    notifications.addNotification({
      type: 'success',
      heading: t('trash.results.restored', { count: restored.length }, restored.length),
      body: lines.join('\n'),
      durationMs: 6000,
    });
  }
  if (failed.length) {
    notifications.addNotification({
      type: 'warning',
      heading: t('trash.results.notRestored', { count: failed.length }, failed.length),
      body: describeFailures(failed),
    });
  }
};

// Share links kept with what is restored: asked once, before anything moves.

const sharesPrompt = ref(null);

/** How many share links the selection — or the whole open folder — kept in the trash. */
const keptSharesOf = ({ entries = false, wholeFolder = false } = {}) => {
  const count = (rows) => rows.reduce((total, row) => total + (Number(row.shareCount) || 0), 0);
  if (wholeFolder) return Number(folder.value?.item?.shareCount) || 0;
  if (entries) {
    return count(
      (folder.value?.entries || []).filter((entry) => selectedEntries.value.has(entry.name))
    );
  }
  return count(items.value.filter((item) => selectedIds.value.has(item.id)));
};

/**
 * What becomes of those share links, asked only when there are some: 'restore'
 * or 'drop', undefined when there is nothing to ask, and null when the question
 * is closed — which restores nothing at all.
 */
const askAboutShares = (count, { elsewhere = false } = {}) => {
  if (!count) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    sharesPrompt.value = { count, elsewhere, resolve };
  });
};

const answerShares = (choice) => {
  const prompt = sharesPrompt.value;
  sharesPrompt.value = null;
  prompt?.resolve(choice);
};

const sharesOption = (shares) => (shares ? { shares } : {});

const restoreSelected = async () => {
  const shares = await askAboutShares(keptSharesOf());
  if (shares === null) return;
  await runBusy(async () => {
    const { items: results = [] } = await restoreTrashItems(
      [...selectedIds.value],
      sharesOption(shares)
    );
    reportRestored(results);
  });
};

const restoreSelectedEntries = async () => {
  const shares = await askAboutShares(keptSharesOf({ entries: true }));
  if (shares === null) return;
  await runBusy(async () => {
    const paths = [...selectedEntries.value].map((name) => joinPath(folderPath.value, name));
    const { items: results = [] } = await restoreTrashEntries(
      folderId.value,
      paths,
      sharesOption(shares)
    );
    reportRestored(results);
  });
};

const restoreWholeFolder = async () => {
  const shares = await askAboutShares(keptSharesOf({ wholeFolder: true }));
  if (shares === null) return;
  await runBusy(async () => {
    const { items: results = [] } = await restoreTrashItems([folderId.value], sharesOption(shares));
    reportRestored(results);
    if (results.some((result) => result.status === 'restored')) await leaveFolder();
  });
};

/*
 * Putting something back somewhere else is not here yet: choosing the folder
 * wants the destination dialog, which arrives with the rest of the file
 * operations. Restoring puts an item back where it was deleted from.
 */

const deleteSelected = () =>
  runBusy(async () => {
    const { items: results = [] } = await deleteTrashItems([...selectedIds.value]);
    const purged = results.filter((result) => result.status === 'purged');
    const failed = results.filter((result) => result.status !== 'purged');
    if (purged.length) {
      notifications.addNotification({
        type: 'success',
        heading: t('trash.results.deleted', { count: purged.length }, purged.length),
        durationMs: 4000,
      });
    }
    if (failed.length) {
      notifications.addNotification({
        type: 'warning',
        heading: t('trash.results.notDeleted', { count: failed.length }, failed.length),
        body: describeFailures(failed),
      });
    }
  });

const emptyAll = () =>
  runBusy(async () => {
    const summary = await emptyTrash();
    notifications.addNotification({
      type: summary?.failed || summary?.unavailable ? 'warning' : 'success',
      heading: t('trash.results.emptied', { count: summary?.purged || 0 }, summary?.purged || 0),
      body:
        summary?.failed || summary?.unavailable
          ? t(
              'trash.results.leftBehind',
              {
                count: (summary.failed || 0) + (summary.unavailable || 0),
              },
              (summary.failed || 0) + (summary.unavailable || 0)
            )
          : '',
      durationMs: 4000,
    });
  });

const askToDelete = () => {
  if (selectedCount.value > 0) pendingConfirm.value = 'delete';
};

const askToEmpty = () => {
  if (items.value.length > 0) pendingConfirm.value = 'empty';
};

const closeConfirm = () => {
  pendingConfirm.value = null;
};

const confirmPending = async () => {
  const action = pendingConfirm.value;
  pendingConfirm.value = null;
  if (action === 'delete') await deleteSelected();
  else if (action === 'empty') await emptyAll();
};

const confirmTitle = computed(() =>
  pendingConfirm.value === 'empty' ? t('trash.confirm.emptyTitle') : t('trash.confirm.deleteTitle')
);

const confirmMessage = computed(() => {
  const emptying = pendingConfirm.value === 'empty';
  const message = emptying
    ? t('trash.confirm.emptyMessage')
    : t('trash.confirm.deleteMessage', { count: selectedCount.value }, selectedCount.value);
  // Deleted for good, share links kept in the trash go for good too.
  const links = emptying
    ? items.value.reduce((total, item) => total + (Number(item.shareCount) || 0), 0)
    : keptSharesOf();
  return links > 0 ? `${message} ${t('trash.shares.deleteNotice')}` : message;
});

const openLocation = (item) => {
  if (!item.openPath) return;
  router.push(folderRoute(item.openPath));
};

const refresh = () => (folderId.value ? loadFolder() : load());

// A right click, a long press, the menu key: the same menu. A double click opens.

const menuState = ref({ open: false, x: 0, y: 0, type: null, target: null });

/*
 * Showing the text of a file that is in the trash is not here yet: it wants
 * the text service, which arrives with the editor. A row opens a folder; a
 * file is put back to be read.
 */

/** A right click on a row that is not selected acts on that row alone, as in the explorer. */
const openMenu = (event, type, target) => {
  if (type === 'item') {
    if (!selectedIds.value.has(target.id)) selectedIds.value = new Set([target.id]);
  } else if (!selectedEntries.value.has(target.name)) {
    selectedEntries.value = new Set([target.name]);
  }
  menuState.value = { open: true, x: event.clientX, y: event.clientY, type, target };
};

const closeMenu = () => {
  menuState.value = { ...menuState.value, open: false };
};

const menuCount = computed(() =>
  menuState.value.type === 'item' ? selectedCount.value : selectedEntryCount.value
);

const menuLabel = computed(() => {
  const { target } = menuState.value;
  if (!target) return '';
  return menuCount.value > 1
    ? t('trash.contextMenu.labelMany', { count: menuCount.value }, menuCount.value)
    : t('trash.contextMenu.label', { name: target.name });
});

const extensionOf = (name = '') => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};

/** A file whose text the editor can show — read only, from the trash. */
const canPreview = (entry) =>
  entry?.kind === 'file' && isEditableExtension(extensionOf(entry.name));

const previewItem = (item) =>
  router.push({ name: 'TrashFileViewer', params: { itemId: item.id, entryPath: [] } });

const previewEntry = (entry) =>
  router.push({
    name: 'TrashFileViewer',
    params: {
      itemId: folderId.value,
      entryPath: joinPath(folderPath.value, entry.name).split('/'),
    },
  });

const menuSections = computed(() => {
  const { type, target } = menuState.value;
  if (!target) return [];
  const single = menuCount.value === 1;
  const reachable = type === 'entry' || target.available;

  const opening = [];
  if (single && reachable && target.kind === 'directory') {
    opening.push({ id: 'open', label: t('trash.contextMenu.open'), icon: FolderOpenIcon });
  }
  if (single && reachable && canPreview(target)) {
    opening.push({ id: 'preview', label: t('trash.contextMenu.preview'), icon: EyeIcon });
  }

  const restoring = [
    {
      id: 'restore',
      label: t('trash.actions.restore'),
      icon: ArrowUturnLeftIcon,
      disabled: busy.value,
    },
  ];
  if (type === 'item' && single && target.openPath) {
    restoring.push({
      id: 'openLocation',
      label: t('trash.actions.openLocation'),
      icon: MapPinIcon,
    });
  }

  const sections = [opening, restoring];
  if (type === 'item') {
    sections.push([
      {
        id: 'delete',
        label: t('trash.actions.deletePermanently'),
        icon: TrashIcon,
        danger: true,
        disabled: busy.value,
      },
    ]);
  }
  return sections;
});

const runMenuAction = (id) => {
  const { type, target } = menuState.value;
  const onItems = type === 'item';
  const actions = {
    open: () => (onItems ? openFolder(target) : openEntry(target)),
    preview: () => (onItems ? previewItem(target) : previewEntry(target)),
    restore: () => (onItems ? restoreSelected() : restoreSelectedEntries()),
    openLocation: () => openLocation(target),
    delete: () => askToDelete(),
  };
  actions[id]?.();
};

/** A double click opens what can be opened: a folder, or the text of a file. */
const openRow = (type, target) => {
  if (type === 'item' && !target.available) return;
  if (target.kind === 'directory') {
    if (type === 'item') openFolder(target);
    else openEntry(target);
  } else if (canPreview(target)) {
    if (type === 'item') previewItem(target);
    else previewEntry(target);
  }
};

/** The menu key, or Shift+F10, on a row's checkbox opens the menu beside it. */
const onMenuKey = (event, type, target) => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu({ clientX: rect.left, clientY: rect.bottom }, type, target);
};

// On a touch screen, holding a row opens the menu a right click does.
const LONG_PRESS_MS = 500;
const LONG_PRESS_TOLERANCE_PX = 10;
let pressTimer = null;
let pressStart = null;
let suppressNextClick = false;

const cancelPress = () => {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = null;
  pressStart = null;
};

const startPress = (event, type, target) => {
  suppressNextClick = false;
  if (event.pointerType !== 'touch') return;
  cancelPress();
  pressStart = { clientX: event.clientX, clientY: event.clientY };
  pressTimer = setTimeout(() => {
    const at = pressStart;
    pressTimer = null;
    pressStart = null;
    // The finger lifting afterwards is not a tap on the row.
    suppressNextClick = true;
    openMenu(at, type, target);
  }, LONG_PRESS_MS);
};

const movePress = (event) => {
  if (!pressStart) return;
  const distance = Math.hypot(
    event.clientX - pressStart.clientX,
    event.clientY - pressStart.clientY
  );
  if (distance > LONG_PRESS_TOLERANCE_PX) cancelPress();
};

const onRowClick = (type, target) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (type === 'item') toggle(target);
  else toggleEntry(target);
};

onBeforeUnmount(cancelPress);

onMounted(load);

defineExpose({ load });
</script>

<template>
  <div class="relative flex h-full max-h-screen flex-col">
    <header
      class="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800"
    >
      <div v-if="folderId" class="min-w-0">
        <nav
          :aria-label="t('trash.browse.breadcrumb')"
          data-test="trash-breadcrumb"
          class="flex min-w-0 flex-wrap items-center gap-1 text-lg font-semibold"
        >
          <button
            type="button"
            data-test="trash-crumb-root"
            class="rounded text-neutral-500 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-white"
            @click="leaveFolder"
          >
            {{ t('trash.title') }}
          </button>
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <ChevronRightIcon class="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
            <h1
              v-if="index === crumbs.length - 1"
              aria-current="page"
              data-test="trash-crumb-current"
              class="truncate text-neutral-900 dark:text-white"
            >
              {{ crumb.label }}
            </h1>
            <button
              v-else
              type="button"
              data-test="trash-crumb"
              class="truncate rounded text-neutral-500 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-white"
              @click="goToCrumb(crumb)"
            >
              {{ crumb.label }}
            </button>
          </template>
        </nav>
        <p
          v-if="folderInfo"
          data-test="trash-folder-info"
          class="text-xs text-neutral-500 dark:text-neutral-400"
        >
          {{ folderInfo }}
        </p>
      </div>
      <div v-else class="min-w-0">
        <h1 class="text-lg font-semibold text-neutral-900 dark:text-white">
          {{ t('trash.title') }}
        </h1>
        <p v-if="subtitle" class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ subtitle }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <template v-if="folderId">
          <button
            type="button"
            data-test="trash-restore-entries"
            class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            :disabled="selectedEntryCount === 0 || busy || !folder"
            @click="restoreSelectedEntries"
          >
            <ArrowUturnLeftIcon class="h-4 w-4" />
            {{ t('trash.actions.restore') }}
          </button>
          <button
            type="button"
            data-test="trash-restore-folder"
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            :disabled="busy || !folder"
            @click="restoreWholeFolder"
          >
            {{ t('trash.actions.restoreFolder') }}
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            data-test="trash-restore"
            class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            :disabled="selectedCount === 0 || busy"
            @click="restoreSelected"
          >
            <ArrowUturnLeftIcon class="h-4 w-4" />
            {{ t('trash.actions.restore') }}
          </button>
          <button
            type="button"
            data-test="trash-delete"
            class="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/50 dark:text-red-300 dark:hover:bg-red-500/10"
            :disabled="selectedCount === 0 || busy"
            @click="askToDelete"
          >
            <TrashIcon class="h-4 w-4" />
            {{ t('trash.actions.deletePermanently') }}
          </button>
          <button
            type="button"
            data-test="trash-empty"
            class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500 dark:hover:bg-red-400"
            :disabled="items.length === 0 || busy"
            @click="askToEmpty"
          >
            {{ t('trash.actions.empty') }}
          </button>
        </template>
        <button
          type="button"
          class="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
          :aria-label="t('common.refresh')"
          :disabled="loading || folderLoading"
          @click="refresh"
        >
          <ArrowPathIcon class="h-5 w-5" />
        </button>
      </div>
    </header>

    <p
      v-if="!enabled"
      data-test="trash-disabled"
      class="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-100"
    >
      {{ t('trash.disabled') }}
    </p>

    <p
      v-if="folderId && entries.length > 0"
      data-test="trash-folder-hint"
      class="mx-4 mt-3 text-sm text-neutral-600 dark:text-neutral-300"
    >
      {{ t('trash.browse.hint') }}
    </p>

    <div class="flex-1 overflow-y-auto px-2">
      <template v-if="folderId">
        <div v-if="folderLoading && !folder" class="flex h-full items-center justify-center">
          <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"></div>
        </div>

        <div
          v-else-if="folderError"
          data-test="trash-folder-error"
          class="flex h-full flex-col items-center justify-center text-red-500"
        >
          <p>{{ folderError }}</p>
          <div class="mt-2 flex gap-4">
            <button type="button" class="text-blue-500 hover:underline" @click="loadFolder">
              {{ t('common.tryAgain') }}
            </button>
            <button
              type="button"
              data-test="trash-folder-back"
              class="text-blue-500 hover:underline"
              @click="leaveFolder"
            >
              {{ t('trash.browse.back') }}
            </button>
          </div>
        </div>

        <div
          v-else-if="folder && entries.length === 0"
          data-test="trash-folder-empty"
          class="flex h-full flex-col items-center justify-center text-neutral-400"
        >
          <FolderOpenIcon class="mb-4 h-16 w-16 opacity-20" />
          <p>{{ t('trash.browse.empty') }}</p>
        </div>

        <div v-else-if="folder" class="min-w-[640px]" role="table" :aria-label="folder.item?.name">
          <div
            role="row"
            :class="[
              'sticky top-0 z-10 grid items-center gap-4 border-b border-neutral-100 bg-white px-4 py-2 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:bg-default dark:text-neutral-400',
              ENTRY_GRID_COLS,
            ]"
          >
            <input
              type="checkbox"
              data-test="trash-select-all-entries"
              :checked="allEntriesSelected"
              :aria-label="t('trash.actions.selectAll')"
              @change="toggleAllEntries"
            />
            <div role="columnheader">{{ t('common.name') }}</div>
            <div role="columnheader">{{ t('trash.columns.modified') }}</div>
            <div role="columnheader" class="text-right">{{ t('common.size') }}</div>
          </div>

          <div class="flex flex-col gap-0.5 pb-4">
            <div
              v-for="entry in entries"
              :key="entry.name"
              role="row"
              data-trash-entry
              :class="[
                'grid cursor-pointer items-center gap-4 rounded-md px-4 py-2 text-sm transition-colors',
                ENTRY_GRID_COLS,
                selectedEntries.has(entry.name)
                  ? 'bg-blue-50 dark:bg-blue-500/10'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50',
              ]"
              @click="onRowClick('entry', entry)"
              @dblclick="openRow('entry', entry)"
              @contextmenu.prevent="openMenu($event, 'entry', entry)"
              @pointerdown="startPress($event, 'entry', entry)"
              @pointermove="movePress"
              @pointerup="cancelPress"
              @pointercancel="cancelPress"
            >
              <input
                type="checkbox"
                :checked="selectedEntries.has(entry.name)"
                :aria-label="t('trash.actions.select', { name: entry.name })"
                @click.stop
                @change="toggleEntry(entry)"
                @keydown="onMenuKey($event, 'entry', entry)"
              />
              <div class="flex min-w-0 items-center gap-2">
                <FileIcon :item="iconItem(entry)" class="h-5 w-5 shrink-0" />
                <button
                  v-if="entry.kind === 'directory'"
                  type="button"
                  data-test="trash-open-entry"
                  data-trash-entry-name
                  class="truncate rounded text-left text-neutral-900 hover:underline dark:text-neutral-100"
                  :aria-label="t('trash.actions.open', { name: entry.name })"
                  @click.stop="openEntry(entry)"
                >
                  {{ entry.name }}
                </button>
                <span
                  v-else
                  class="truncate text-neutral-900 dark:text-neutral-100"
                  data-trash-entry-name
                >
                  {{ entry.name }}
                </span>
                <span
                  v-if="entry.shareCount > 0"
                  data-test="trash-shared"
                  class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-500/15 dark:text-blue-200"
                  :title="
                    t('trash.shares.badgeTitle', { count: entry.shareCount }, entry.shareCount)
                  "
                >
                  {{ t('trash.shares.badge') }}
                </span>
              </div>
              <div class="text-neutral-600 dark:text-neutral-300">
                {{ entry.modifiedAt ? formatLocalDateTime(entry.modifiedAt) : '' }}
              </div>
              <div
                class="text-right tabular-nums text-neutral-600 dark:text-neutral-300"
                data-trash-entry-size
              >
                {{ Number.isFinite(entry.size) ? formatBytes(entry.size) : '—' }}
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div v-if="loading && items.length === 0" class="flex h-full items-center justify-center">
          <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"></div>
        </div>

        <div
          v-else-if="error"
          data-test="trash-error"
          class="flex h-full flex-col items-center justify-center text-red-500"
        >
          <p>{{ error }}</p>
          <button type="button" class="mt-2 text-blue-500 hover:underline" @click="load">
            {{ t('common.tryAgain') }}
          </button>
        </div>

        <div
          v-else-if="items.length === 0"
          data-test="trash-empty-state"
          class="flex h-full flex-col items-center justify-center text-neutral-400"
        >
          <TrashIcon class="mb-4 h-16 w-16 opacity-20" />
          <p>{{ t('trash.empty') }}</p>
        </div>

        <div v-else class="min-w-[900px]" role="table" :aria-label="t('trash.title')">
          <div
            role="row"
            :class="[
              'sticky top-0 z-10 grid items-center gap-4 border-b border-neutral-100 bg-white px-4 py-2 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:bg-default dark:text-neutral-400',
              GRID_COLS,
            ]"
          >
            <input
              type="checkbox"
              data-test="trash-select-all"
              :checked="allSelected"
              :aria-label="t('trash.actions.selectAll')"
              @change="toggleAll"
            />
            <div role="columnheader">{{ t('common.name') }}</div>
            <div role="columnheader">{{ t('trash.columns.originalLocation') }}</div>
            <div role="columnheader">{{ t('trash.columns.deletedBy') }}</div>
            <div role="columnheader">{{ t('trash.columns.deletedAt') }}</div>
            <div role="columnheader">{{ t('trash.columns.expires') }}</div>
            <div role="columnheader" class="text-right">{{ t('common.size') }}</div>
            <div></div>
          </div>

          <div class="flex flex-col gap-0.5 pb-4">
            <div
              v-for="item in items"
              :key="item.id"
              role="row"
              data-trash-row
              :class="[
                'grid cursor-pointer items-center gap-4 rounded-md px-4 py-2 text-sm transition-colors',
                GRID_COLS,
                selectedIds.has(item.id)
                  ? 'bg-blue-50 dark:bg-blue-500/10'
                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50',
                item.available ? '' : 'opacity-60',
              ]"
              @click="onRowClick('item', item)"
              @dblclick="openRow('item', item)"
              @contextmenu.prevent="openMenu($event, 'item', item)"
              @pointerdown="startPress($event, 'item', item)"
              @pointermove="movePress"
              @pointerup="cancelPress"
              @pointercancel="cancelPress"
            >
              <input
                type="checkbox"
                :checked="selectedIds.has(item.id)"
                :aria-label="t('trash.actions.select', { name: item.name })"
                @click.stop
                @change="toggle(item)"
                @keydown="onMenuKey($event, 'item', item)"
              />
              <div class="flex min-w-0 items-center gap-2">
                <FileIcon :item="iconItem(item)" class="h-5 w-5 shrink-0" />
                <button
                  v-if="item.kind === 'directory' && item.available"
                  type="button"
                  data-test="trash-open-folder"
                  data-trash-name
                  class="truncate rounded text-left text-neutral-900 hover:underline dark:text-neutral-100"
                  :aria-label="t('trash.actions.open', { name: item.name })"
                  @click.stop="openFolder(item)"
                >
                  {{ item.name }}
                </button>
                <span
                  v-else
                  class="truncate text-neutral-900 dark:text-neutral-100"
                  data-trash-name
                >
                  {{ item.name }}
                </span>
                <span
                  v-if="item.shareCount > 0"
                  data-test="trash-shared"
                  class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-500/15 dark:text-blue-200"
                  :title="t('trash.shares.badgeTitle', { count: item.shareCount }, item.shareCount)"
                >
                  {{ t('trash.shares.badge') }}
                </span>
                <span
                  v-if="!item.available"
                  data-test="trash-unavailable"
                  class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
                >
                  {{ t('trash.unavailable') }}
                </span>
              </div>
              <div class="truncate text-neutral-600 dark:text-neutral-300" data-trash-location>
                {{ locationLabel(item) }}
              </div>
              <div class="truncate text-neutral-600 dark:text-neutral-300" data-trash-deleted-by>
                {{ deletedByLabel(item) }}
              </div>
              <div class="text-neutral-600 dark:text-neutral-300">
                {{ formatLocalDateTime(item.deletedAt) }}
              </div>
              <div class="text-neutral-600 dark:text-neutral-300" data-trash-expires>
                {{ expiresLabel(item) }}
              </div>
              <div class="text-right tabular-nums text-neutral-600 dark:text-neutral-300">
                {{ formatBytes(item.size) }}
              </div>
              <div>
                <button
                  v-if="item.openPath"
                  type="button"
                  data-test="trash-open-location"
                  class="rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  :aria-label="t('trash.actions.openLocation')"
                  :title="t('trash.actions.openLocation')"
                  @click.stop="openLocation(item)"
                >
                  <FolderOpenIcon class="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <TrashContextMenu
      :open="menuState.open"
      :x="menuState.x"
      :y="menuState.y"
      :sections="menuSections"
      :label="menuLabel"
      @select="runMenuAction"
      @close="closeMenu"
    />

    <ModalDialog :model-value="Boolean(pendingConfirm)" @update:model-value="closeConfirm">
      <template #title>{{ confirmTitle }}</template>
      <p class="mb-6 text-base text-zinc-700 dark:text-zinc-200" data-test="trash-confirm-message">
        {{ confirmMessage }}
      </p>
      <div class="flex justify-end gap-3">
        <button
          type="button"
          class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
          @click="closeConfirm"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          data-test="trash-confirm"
          class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 dark:bg-red-500 dark:hover:bg-red-400"
          @click="confirmPending"
        >
          {{ t('trash.actions.deletePermanently') }}
        </button>
      </div>
    </ModalDialog>

    <ModalDialog :model-value="Boolean(sharesPrompt)" @update:model-value="answerShares(null)">
      <template #title>{{ t('trash.shares.chooseTitle') }}</template>
      <p class="mb-3 text-base text-zinc-700 dark:text-zinc-200" data-test="trash-shares-message">
        {{
          t(
            'trash.shares.chooseMessage',
            { count: sharesPrompt?.count || 0 },
            sharesPrompt?.count || 0
          )
        }}
      </p>
      <p
        v-if="sharesPrompt?.elsewhere"
        data-test="trash-shares-elsewhere"
        class="mb-3 text-sm text-zinc-600 dark:text-zinc-300"
      >
        {{ t('trash.shares.chooseElsewhere') }}
      </p>
      <div class="mt-6 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          data-test="trash-shares-cancel"
          class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
          @click="answerShares(null)"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          data-test="trash-shares-drop"
          class="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-500/50 dark:text-red-300 dark:hover:bg-red-500/10"
          @click="answerShares('drop')"
        >
          {{ t('trash.shares.drop') }}
        </button>
        <button
          type="button"
          data-test="trash-shares-keep"
          class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          @click="answerShares('restore')"
        >
          {{ t('trash.shares.keep') }}
        </button>
      </div>
    </ModalDialog>
  </div>
</template>
