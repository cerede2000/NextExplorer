<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import FileIcon from '@/icons/FileIcon.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import {
  deleteTrashItems,
  emptyTrash,
  getTrash,
  getTrashEntries,
  restoreTrashEntries,
  restoreTrashEntriesTo,
  restoreTrashItems,
  restoreTrashItemsTo,
} from '@/api';
import { useDestinationPicker } from '@/composables/useDestinationPicker';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';
import { formatBytes, formatLocalDateTime } from '@/utils';

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

const restoreSelected = () =>
  runBusy(async () => {
    const { items: results = [] } = await restoreTrashItems([...selectedIds.value]);
    reportRestored(results);
  });

const restoreSelectedEntries = () =>
  runBusy(async () => {
    const paths = [...selectedEntries.value].map((name) => joinPath(folderPath.value, name));
    const { items: results = [] } = await restoreTrashEntries(folderId.value, paths);
    reportRestored(results);
  });

const restoreWholeFolder = () =>
  runBusy(async () => {
    const { items: results = [] } = await restoreTrashItems([folderId.value]);
    reportRestored(results);
    if (results.some((result) => result.status === 'restored')) await leaveFolder();
  });

const picker = useDestinationPicker();
const operationTasks = useOperationTasksStore();

/**
 * Put what is selected in a folder chosen with the dialog a move uses. Across
 * disks that is a copy, so it runs as a task with its progress and a cancel,
 * like a transfer; whatever the cancel stops stays in the trash, and the list
 * reloaded afterwards shows exactly what came out.
 */
const restoreElsewhere = async ({ entries = false } = {}) => {
  const count = entries ? selectedEntryCount.value : selectedCount.value;
  if (count === 0 || busy.value) return;
  const destination = await picker.pick({ mode: 'restore' });
  if (!destination) return;

  const controller = new AbortController();
  const operationId = operationTasks.startOperation({
    type: 'restore',
    itemCount: count,
    destination,
    cancellable: true,
    cancel: () => controller.abort(),
  });
  const onEvent = (event) => {
    if (event?.type !== 'start' && event?.type !== 'progress') return;
    operationTasks.updateOperation(operationId, {
      totalBytes: Number(event.totalBytes) || 0,
      copiedBytes: Number(event.copiedBytes) || 0,
    });
  };
  const options = { onEvent, signal: controller.signal };

  await runBusy(async () => {
    try {
      const response = entries
        ? await restoreTrashEntriesTo(
            folderId.value,
            [...selectedEntries.value].map((name) => joinPath(folderPath.value, name)),
            destination,
            options
          )
        : await restoreTrashItemsTo([...selectedIds.value], destination, options);
      reportRestored(response?.items || []);
    } catch (err) {
      if (!controller.signal.aborted && err?.name !== 'AbortError') throw err;
    } finally {
      operationTasks.finishOperation(operationId);
    }
  });
};

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

const confirmMessage = computed(() =>
  pendingConfirm.value === 'empty'
    ? t('trash.confirm.emptyMessage')
    : t('trash.confirm.deleteMessage', { count: selectedCount.value }, selectedCount.value)
);

const openLocation = (item) => {
  if (!item.openPath) return;
  router.push({ name: 'FolderView', params: { path: item.openPath } });
};

const refresh = () => (folderId.value ? loadFolder() : load());

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
            data-test="trash-restore-entries-to"
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            :disabled="selectedEntryCount === 0 || busy || !folder"
            @click="restoreElsewhere({ entries: true })"
          >
            {{ t('trash.actions.restoreTo') }}
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
            data-test="trash-restore-to"
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            :disabled="selectedCount === 0 || busy"
            @click="restoreElsewhere()"
          >
            {{ t('trash.actions.restoreTo') }}
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
              @click="toggleEntry(entry)"
            >
              <input
                type="checkbox"
                :checked="selectedEntries.has(entry.name)"
                :aria-label="t('trash.actions.select', { name: entry.name })"
                @click.stop
                @change="toggleEntry(entry)"
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
              @click="toggle(item)"
            >
              <input
                type="checkbox"
                :checked="selectedIds.has(item.id)"
                :aria-label="t('trash.actions.select', { name: item.name })"
                @click.stop
                @change="toggle(item)"
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
  </div>
</template>
