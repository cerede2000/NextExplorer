<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/vue/20/solid';

import ModalDialog from '@/components/ModalDialog.vue';
import { deleteVersionsOfFile, getVersionedFile, getVersionedFiles } from '@/api';
import { formatBytes, formatLocalDateTime } from '@/utils';

/**
 * Every file that has a history, for an administrator.
 *
 * The panel in the browser answers "what happened to this file". Nothing
 * answered "where has the space gone", and the histories most worth finding
 * are the ones nobody goes looking for: a file deleted outside the
 * application leaves its versions behind, and they are then the only copy
 * left. So the list is ordered by the space it holds by default, and says for
 * each history whether its file is still there.
 *
 * It shows paths from every space, personal folders included, which is not
 * something one account can otherwise see of another — hence admin-only, and
 * hence said on the page rather than left to be discovered.
 */

const { t } = useI18n();

const PAGE_SIZE = 25;

const loading = ref(false);
const error = ref('');
const page = ref({ files: [], total: 0, totalBytes: 0, totalVersions: 0, zones: [], states: [] });
const filters = ref({ q: '', zone: '', state: '', sort: 'bytes' });
const offset = ref(0);

/** Which rows are open, and what their versions turned out to be. */
const expanded = ref(new Set());
const details = ref(new Map());
const detailError = ref(new Map());
const selection = ref(new Map());

const confirmation = ref(null);
const working = ref(false);

const load = async () => {
  loading.value = true;
  error.value = '';
  try {
    page.value = await getVersionedFiles({
      q: filters.value.q || undefined,
      zone: filters.value.zone || undefined,
      state: filters.value.state || undefined,
      sort: filters.value.sort,
      limit: PAGE_SIZE,
      offset: offset.value,
    });
  } catch (caught) {
    error.value = caught?.message || t('settings.fileVersions.loadFailed');
  } finally {
    loading.value = false;
  }
};

/** A filter changed: back to the first page, or the list shows page four of one. */
const refilter = async () => {
  offset.value = 0;
  expanded.value = new Set();
  await load();
};

const goto = async (next) => {
  offset.value = Math.max(0, next);
  expanded.value = new Set();
  await load();
};

const loadDetail = async (file) => {
  detailError.value.delete(file.id);
  try {
    details.value.set(file.id, await getVersionedFile(file.id));
  } catch (caught) {
    detailError.value.set(file.id, caught?.message || t('settings.fileVersions.detailFailed'));
  }
  // A Map mutated in place is the same object; Vue is told by replacing it.
  details.value = new Map(details.value);
  detailError.value = new Map(detailError.value);
};

const toggle = async (file) => {
  const open = new Set(expanded.value);
  if (open.has(file.id)) {
    open.delete(file.id);
    expanded.value = open;
    return;
  }
  open.add(file.id);
  expanded.value = open;
  if (!details.value.has(file.id)) await loadDetail(file);
};

const chosen = (fileId) => selection.value.get(fileId) || new Set();

const toggleVersion = (fileId, versionId) => {
  const next = new Set(chosen(fileId));
  if (next.has(versionId)) next.delete(versionId);
  else next.add(versionId);
  const map = new Map(selection.value);
  if (next.size === 0) map.delete(fileId);
  else map.set(fileId, next);
  selection.value = map;
};

const askDeleteSelected = (file) => {
  const ids = [...chosen(file.id)];
  if (ids.length === 0) return;
  confirmation.value = { kind: 'some', file, ids };
};

const askDeleteAll = (file) => {
  confirmation.value = { kind: 'all', file };
};

const confirmationOpen = computed({
  get: () => Boolean(confirmation.value),
  set: (value) => {
    if (!value) confirmation.value = null;
  },
});

const confirmationTitle = computed(() => {
  const request = confirmation.value;
  if (!request) return '';
  return request.kind === 'all'
    ? t('settings.fileVersions.confirmAllTitle', { name: request.file.name })
    : t(
        'settings.fileVersions.confirmSomeTitle',
        { count: request.ids.length },
        request.ids.length
      );
});

const runDeletion = async () => {
  const request = confirmation.value;
  if (!request) return;
  confirmation.value = null;
  working.value = true;
  error.value = '';
  try {
    await deleteVersionsOfFile(
      request.file.id,
      request.kind === 'all' ? { all: true } : { ids: request.ids }
    );
    const map = new Map(selection.value);
    map.delete(request.file.id);
    selection.value = map;
    // Both, and in this order: the row's own counts come from the list, and
    // the versions under it from the history. Reloading one and not the other
    // is a row that says three versions above a list of none.
    await load();
    if (expanded.value.has(request.file.id)) await loadDetail(request.file);
  } catch (caught) {
    error.value = caught?.message || t('settings.fileVersions.deleteFailed');
  } finally {
    working.value = false;
  }
};

/** Nothing ticked is not "delete none": the button says what to do first. */
const deleteSelectedLabel = (file) => {
  const count = chosen(file.id).size;
  return count === 0
    ? t('settings.fileVersions.deleteSelectedNone')
    : t('settings.fileVersions.deleteSelected', { count }, count);
};

const zoneLabel = (zone) => {
  if (!zone) return t('settings.fileVersions.zoneUnknown');
  return t(`settings.fileVersions.zoneKinds.${zone.kind}`, { name: zone.name });
};

const stateLabel = (state) => t(`settings.fileVersions.states.${state}`);

const stateClass = (state) =>
  ({
    live: 'text-zinc-500 dark:text-zinc-400',
    trashed: 'text-amber-700 dark:text-amber-300',
    orphaned: 'text-red-700 dark:text-red-300',
  })[state] || 'text-zinc-500 dark:text-zinc-400';

const from = computed(() => (page.value.total === 0 ? 0 : offset.value + 1));
const to = computed(() => Math.min(page.value.total, offset.value + page.value.files.length));

onMounted(load);

const buttonClasses =
  'inline-flex justify-center rounded-md border border-transparent bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200';
const quietButtonClasses =
  'inline-flex justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800';
const dangerButtonClasses =
  'inline-flex justify-center rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30';
const inputClasses =
  'block rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100';
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.fileVersions.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.fileVersions.intro') }}
      </p>
    </div>

    <div
      class="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label
            for="versions-search"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.fileVersions.search') }}
          </label>
          <input
            id="versions-search"
            v-model="filters.q"
            type="search"
            :class="inputClasses"
            :placeholder="t('settings.fileVersions.searchPlaceholder')"
            data-test="versions-search"
            @keyup.enter="refilter()"
          />
        </div>
        <div>
          <label
            for="versions-zone"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.fileVersions.zone') }}
          </label>
          <select
            id="versions-zone"
            v-model="filters.zone"
            :class="inputClasses"
            data-test="versions-zone"
            @change="refilter()"
          >
            <option value="">{{ t('settings.fileVersions.anyZone') }}</option>
            <option v-for="zone in page.zones" :key="zone.id" :value="zone.id">
              {{ zoneLabel(zone) }}
            </option>
          </select>
        </div>
        <div>
          <label
            for="versions-state"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.fileVersions.state') }}
          </label>
          <select
            id="versions-state"
            v-model="filters.state"
            :class="inputClasses"
            data-test="versions-state"
            @change="refilter()"
          >
            <option value="">{{ t('settings.fileVersions.anyState') }}</option>
            <option v-for="state in page.states" :key="state" :value="state">
              {{ stateLabel(state) }}
            </option>
          </select>
        </div>
        <div>
          <label
            for="versions-sort"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.fileVersions.sort') }}
          </label>
          <select
            id="versions-sort"
            v-model="filters.sort"
            :class="inputClasses"
            data-test="versions-sort"
            @change="refilter()"
          >
            <option value="bytes">{{ t('settings.fileVersions.sortBytes') }}</option>
            <option value="versions">{{ t('settings.fileVersions.sortCount') }}</option>
            <option value="newest">{{ t('settings.fileVersions.sortNewest') }}</option>
            <option value="path">{{ t('settings.fileVersions.sortPath') }}</option>
          </select>
        </div>
        <button
          type="button"
          :class="quietButtonClasses"
          :disabled="loading"
          data-test="versions-refresh"
          @click="load()"
        >
          {{ t('common.refresh') }}
        </button>
      </div>

      <p class="text-sm text-zinc-600 dark:text-zinc-300" data-test="versions-summary">
        {{
          t('settings.fileVersions.summary', {
            files: page.total,
            versions: page.totalVersions,
            size: formatBytes(page.totalBytes),
          })
        }}
      </p>

      <p v-if="error" class="text-sm text-red-600" data-test="versions-error">{{ error }}</p>

      <div v-if="page.files.length" class="overflow-x-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="text-xs uppercase text-zinc-500 dark:text-zinc-400">
            <tr>
              <th scope="col" class="py-2 pr-4">{{ t('settings.fileVersions.file') }}</th>
              <th scope="col" class="py-2 pr-4">{{ t('settings.fileVersions.state') }}</th>
              <th scope="col" class="py-2 pr-4 text-right">
                {{ t('settings.fileVersions.count') }}
              </th>
              <th scope="col" class="py-2 pr-4 text-right">
                {{ t('settings.fileVersions.size') }}
              </th>
              <th scope="col" class="py-2 pr-4">{{ t('settings.fileVersions.newest') }}</th>
              <th scope="col" class="py-2"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
            <template v-for="file in page.files" :key="file.id">
              <tr data-test="versions-row">
                <td class="py-2 pr-4">
                  <button
                    type="button"
                    class="flex max-w-md items-start gap-1 text-left"
                    :aria-expanded="expanded.has(file.id)"
                    data-test="versions-expand"
                    @click="toggle(file)"
                  >
                    <component
                      :is="expanded.has(file.id) ? ChevronDownIcon : ChevronRightIcon"
                      class="mt-0.5 h-4 w-4 shrink-0 text-zinc-400"
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-zinc-900 dark:text-zinc-100">
                        {{ file.name }}
                      </span>
                      <span class="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {{ zoneLabel(file.zone)
                        }}<template v-if="file.folder"> · {{ file.folder }}</template>
                      </span>
                    </span>
                  </button>
                </td>
                <td class="py-2 pr-4 whitespace-nowrap" :class="stateClass(file.state)">
                  {{ stateLabel(file.state) }}
                </td>
                <td
                  class="py-2 pr-4 text-right tabular-nums text-zinc-900 dark:text-zinc-100"
                  data-test="versions-count"
                >
                  {{ file.versions }}
                </td>
                <td class="py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {{ formatBytes(file.bytes) }}
                </td>
                <td class="py-2 pr-4 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  {{ file.newest ? formatLocalDateTime(file.newest) : '—' }}
                </td>
                <td class="py-2 text-right">
                  <button
                    type="button"
                    :class="dangerButtonClasses"
                    :disabled="working"
                    data-test="versions-delete-all"
                    @click="askDeleteAll(file)"
                  >
                    {{ t('settings.fileVersions.deleteAll') }}
                  </button>
                </td>
              </tr>
              <tr v-if="expanded.has(file.id)" data-test="versions-detail">
                <td colspan="6" class="bg-zinc-50 px-4 py-3 dark:bg-zinc-800/40">
                  <p v-if="detailError.get(file.id)" class="text-sm text-red-600">
                    {{ detailError.get(file.id) }}
                  </p>
                  <p
                    v-else-if="!details.get(file.id)"
                    class="text-sm text-zinc-500 dark:text-zinc-400"
                  >
                    {{ t('common.loading') }}
                  </p>
                  <div v-else class="space-y-3">
                    <ul class="divide-y divide-zinc-200 dark:divide-zinc-700">
                      <li
                        v-for="version in details.get(file.id).versions"
                        :key="version.id"
                        class="flex flex-wrap items-center gap-3 py-2"
                        data-test="versions-version"
                      >
                        <input
                          type="checkbox"
                          class="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
                          :checked="chosen(file.id).has(version.id)"
                          :aria-label="formatLocalDateTime(version.modifiedAt)"
                          @change="toggleVersion(file.id, version.id)"
                        />
                        <span class="text-sm text-zinc-900 dark:text-zinc-100">
                          {{ formatLocalDateTime(version.modifiedAt) }}
                        </span>
                        <span class="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
                          {{ formatBytes(version.size) }}
                        </span>
                        <span v-if="version.author?.label" class="text-sm text-zinc-500">
                          {{ version.author.label }}
                        </span>
                        <span
                          v-if="version.label"
                          class="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
                        >
                          {{ version.label }}
                        </span>
                        <span
                          v-if="version.pinned"
                          class="text-xs text-blue-600 dark:text-blue-400"
                        >
                          {{ t('settings.fileVersions.pinned') }}
                        </span>
                        <span
                          v-if="version.available === false"
                          class="text-xs text-amber-700 dark:text-amber-300"
                        >
                          {{ t('settings.fileVersions.unavailable') }}
                        </span>
                      </li>
                    </ul>
                    <button
                      type="button"
                      :class="dangerButtonClasses"
                      :disabled="working || chosen(file.id).size === 0"
                      data-test="versions-delete-selected"
                      @click="askDeleteSelected(file)"
                    >
                      {{ deleteSelectedLabel(file) }}
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <p
        v-else-if="!loading"
        class="text-sm text-zinc-600 dark:text-zinc-300"
        data-test="versions-empty"
      >
        {{ t('settings.fileVersions.none') }}
      </p>

      <div v-if="page.total > page.files.length" class="flex items-center gap-3">
        <button
          type="button"
          :class="quietButtonClasses"
          :disabled="loading || offset === 0"
          data-test="versions-previous"
          @click="goto(offset - PAGE_SIZE)"
        >
          {{ t('settings.fileVersions.previous') }}
        </button>
        <span class="text-sm text-zinc-500 dark:text-zinc-400" data-test="versions-range">
          {{ t('settings.fileVersions.range', { from, to, total: page.total }) }}
        </span>
        <button
          type="button"
          :class="quietButtonClasses"
          :disabled="loading || to >= page.total"
          data-test="versions-next"
          @click="goto(offset + PAGE_SIZE)"
        >
          {{ t('settings.fileVersions.next') }}
        </button>
      </div>
    </div>

    <ModalDialog v-model="confirmationOpen">
      <template #title>{{ confirmationTitle }}</template>
      <p class="text-sm text-zinc-700 dark:text-zinc-200" data-test="versions-confirm-message">
        {{ t('settings.fileVersions.confirmMessage') }}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" :class="quietButtonClasses" @click="confirmation = null">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          :class="buttonClasses"
          data-test="versions-confirm"
          @click="runDeletion"
        >
          {{ t('settings.fileVersions.deleteForGood') }}
        </button>
      </div>
    </ModalDialog>
  </div>
</template>
