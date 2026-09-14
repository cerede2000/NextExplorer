<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  FolderOpenIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import FileIcon from '@/icons/FileIcon.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import { deleteTrashItems, emptyTrash, getTrash, restoreTrashItems } from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { formatBytes, formatLocalDateTime } from '@/utils';

/**
 * The trash: what this person deleted, and what came from their own folder or
 * shares — everything, for an administrator.
 *
 * The server decides who sees what and who may restore where; this screen
 * says what happened to each request, including the ones it refused, so an
 * item that could not go back never just stays in the list without a word.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GRID_COLS =
  'grid-cols-[28px_minmax(0,3fr)_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_90px_36px]';

const { t } = useI18n();
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

const REASONS = {
  forbidden: 'forbidden',
  blocked: 'blocked',
  unavailable: 'unavailable',
  busy: 'busy',
  lost: 'lost',
  'not-found': 'notFound',
  missing: 'notFound',
};

const reasonText = (result) => t(`trash.reasons.${REASONS[result.status] || 'unknown'}`);

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
  }
};

const restoreSelected = () =>
  runBusy(async () => {
    const { items: results = [] } = await restoreTrashItems([...selectedIds.value]);
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
  });

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

onMounted(load);

defineExpose({ load });
</script>

<template>
  <div class="relative flex h-full max-h-screen flex-col">
    <header
      class="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800"
    >
      <div class="min-w-0">
        <h1 class="text-lg font-semibold text-neutral-900 dark:text-white">
          {{ t('trash.title') }}
        </h1>
        <p v-if="subtitle" class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ subtitle }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
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
        <button
          type="button"
          class="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
          :aria-label="t('common.refresh')"
          :disabled="loading"
          @click="load"
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

    <div class="flex-1 overflow-y-auto px-2">
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
              <span class="truncate text-neutral-900 dark:text-neutral-100" data-trash-name>
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
