<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { clearActivity, fetchActivity } from '@/api';
import { useAppSettings } from '@/stores/appSettings';
import { formatLocalDateTime } from '@/utils';

/**
 * The activity log, for an administrator: the switch that fills it, how long a
 * line is kept, and what is in it.
 *
 * The switch comes first on the page because it is the feature. Off, the list
 * below is empty and says why rather than looking broken — nothing was
 * recorded, which is not the same as nothing having happened.
 */

const appSettings = useAppSettings();
const { t } = useI18n();

const current = computed(
  () => appSettings.systemSettings?.activity || { enabled: false, retentionDays: 90 }
);

const local = ref({
  enabled: current.value.enabled,
  retentionDays: String(current.value.retentionDays ?? 90),
});

watch(
  current,
  (value) => {
    local.value = { enabled: value.enabled, retentionDays: String(value.retentionDays ?? 90) };
  },
  { deep: true }
);

const retentionDays = computed(() => {
  const value = Number(local.value.retentionDays);
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
});

const invalid = computed(() => retentionDays.value === null);
const changed = computed(
  () =>
    local.value.enabled !== current.value.enabled ||
    retentionDays.value !== current.value.retentionDays
);

const saving = ref(false);
const saveError = ref('');

const save = async () => {
  if (invalid.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await appSettings.save({
      activity: { enabled: local.value.enabled, retentionDays: retentionDays.value },
    });
    await load();
  } catch (error) {
    saveError.value = error?.message || t('settings.activity.saveFailed');
  } finally {
    saving.value = false;
  }
};

/** The list itself. */
const events = ref([]);
const actions = ref([]);
const enabled = ref(false);
const nextBefore = ref(null);
const loading = ref(false);
const listError = ref('');
const filters = ref({ action: '', outcome: '', q: '' });

const load = async ({ more = false } = {}) => {
  loading.value = true;
  listError.value = '';
  try {
    const page = await fetchActivity({
      ...filters.value,
      before: more ? nextBefore.value : undefined,
      limit: 100,
    });
    events.value = more ? [...events.value, ...page.events] : page.events;
    actions.value = page.actions || [];
    enabled.value = Boolean(page.enabled);
    nextBefore.value = page.nextBefore;
  } catch (error) {
    listError.value = error?.message || t('settings.activity.loadFailed');
  } finally {
    loading.value = false;
  }
};

const empty = async () => {
  loading.value = true;
  listError.value = '';
  try {
    await clearActivity();
    await load();
  } catch (error) {
    listError.value = error?.message || t('settings.activity.clearFailed');
  } finally {
    loading.value = false;
  }
};

onMounted(load);

const buttonClasses =
  'inline-flex justify-center rounded-md border border-transparent bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200';
const quietButtonClasses =
  'inline-flex justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800';
const inputClasses =
  'block rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100';
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.activity.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.activity.intro') }}
      </p>
    </div>

    <div
      class="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.activity.enabled') }}
          </p>
          <p class="text-xs text-zinc-500 dark:text-zinc-400">
            {{ t('settings.activity.enabledHelp') }}
          </p>
        </div>
        <ToggleSwitch v-model="local.enabled" data-test="activity-enabled" />
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label
            for="activity-retention"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.activity.retention') }}
          </label>
          <input
            id="activity-retention"
            v-model="local.retentionDays"
            type="number"
            min="1"
            max="3650"
            :class="[inputClasses, 'w-32']"
            data-test="activity-retention"
          />
        </div>
        <button
          type="button"
          :class="buttonClasses"
          :disabled="saving || invalid || !changed"
          data-test="activity-save"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
      </div>
      <p v-if="invalid" class="text-sm text-red-600" data-test="activity-invalid">
        {{ t('settings.activity.retentionInvalid') }}
      </p>
      <p v-if="saveError" class="text-sm text-red-600" data-test="activity-save-error">
        {{ saveError }}
      </p>
    </div>

    <div
      class="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label
            for="activity-action"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.activity.filterAction') }}
          </label>
          <select
            id="activity-action"
            v-model="filters.action"
            :class="inputClasses"
            data-test="activity-filter-action"
            @change="load()"
          >
            <option value="">{{ t('settings.activity.anyAction') }}</option>
            <option v-for="name in actions" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>
        <div>
          <label
            for="activity-search"
            class="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {{ t('settings.activity.filterText') }}
          </label>
          <input
            id="activity-search"
            v-model="filters.q"
            type="search"
            :class="inputClasses"
            :placeholder="t('settings.activity.filterTextPlaceholder')"
            data-test="activity-filter-text"
            @keyup.enter="load()"
          />
        </div>
        <button
          type="button"
          :class="quietButtonClasses"
          :disabled="loading"
          data-test="activity-refresh"
          @click="load()"
        >
          {{ t('settings.activity.refresh') }}
        </button>
        <button
          type="button"
          :class="quietButtonClasses"
          :disabled="loading || !events.length"
          data-test="activity-clear"
          @click="empty"
        >
          {{ t('settings.activity.clear') }}
        </button>
      </div>

      <p v-if="listError" class="text-sm text-red-600" data-test="activity-error">
        {{ listError }}
      </p>

      <p
        v-if="!enabled"
        class="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        data-test="activity-off"
      >
        {{ t('settings.activity.off') }}
      </p>

      <div v-if="events.length" class="overflow-x-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="text-xs text-zinc-500 uppercase dark:text-zinc-400">
            <tr>
              <th scope="col" class="py-2 pr-4">{{ t('settings.activity.when') }}</th>
              <th scope="col" class="py-2 pr-4">{{ t('settings.activity.who') }}</th>
              <th scope="col" class="py-2 pr-4">{{ t('settings.activity.what') }}</th>
              <th scope="col" class="py-2 pr-4">{{ t('settings.activity.target') }}</th>
              <th scope="col" class="py-2">{{ t('settings.activity.from') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
            <tr v-for="event in events" :key="event.id" data-test="activity-row">
              <td class="py-2 pr-4 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                {{ formatLocalDateTime(event.at) }}
              </td>
              <td class="py-2 pr-4 text-zinc-900 dark:text-zinc-100">{{ event.actor }}</td>
              <td class="py-2 pr-4">
                <span
                  class="font-mono text-xs"
                  :class="
                    event.outcome === 'refused'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-zinc-700 dark:text-zinc-300'
                  "
                >
                  {{ event.action }}
                  <span v-if="event.outcome === 'refused'">
                    · {{ t('settings.activity.refused') }}</span
                  >
                </span>
              </td>
              <td class="max-w-xs truncate py-2 pr-4 text-zinc-700 dark:text-zinc-300">
                {{ event.target || '—' }}
              </td>
              <td class="py-2 text-zinc-500 dark:text-zinc-400">{{ event.ip || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-else-if="enabled && !loading"
        class="text-sm text-zinc-600 dark:text-zinc-300"
        data-test="activity-empty"
      >
        {{ t('settings.activity.none') }}
      </p>

      <button
        v-if="nextBefore"
        type="button"
        :class="quietButtonClasses"
        :disabled="loading"
        data-test="activity-more"
        @click="load({ more: true })"
      >
        {{ t('settings.activity.more') }}
      </button>
    </div>
  </div>
</template>
