<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { getTrashZones, runTrashMaintenance, verifyTrash } from '@/api';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';
import { formatBytes, formatLocalDateTime } from '@/utils';

/**
 * The trash, for an administrator: whether deleting goes there, how long it
 * keeps things and how much of a volume it may hold — and, per zone, what it
 * holds, what the last maintenance did, and whether its books and its disk
 * still agree.
 */

const GIB = 1024 ** 3;

const appSettings = useAppSettings();
const featuresStore = useFeaturesStore();
const { t } = useI18n();

const current = computed(
  () =>
    appSettings.systemSettings?.trash || {
      enabled: true,
      retentionDays: 30,
      maxPercent: 10,
      maxBytes: null,
    }
);

const fromSettings = (settings) => ({
  enabled: settings.enabled !== false,
  retentionDays: String(settings.retentionDays ?? 30),
  maxPercent: String(settings.maxPercent ?? 10),
  maxSizeGiB:
    Number.isFinite(settings.maxBytes) && settings.maxBytes > 0
      ? String(Math.round((settings.maxBytes / GIB) * 100) / 100)
      : '',
});

const local = ref(fromSettings(current.value));

watch(
  current,
  (value) => {
    local.value = fromSettings(value);
  },
  { deep: true }
);

const integerIn = (raw, min, max) => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

const parsed = computed(() => {
  const size = String(local.value.maxSizeGiB || '')
    .trim()
    .replace(',', '.');
  const gib = size === '' ? null : Number(size);
  return {
    enabled: local.value.enabled,
    retentionDays: integerIn(local.value.retentionDays, 1, 3650),
    maxPercent: integerIn(local.value.maxPercent, 1, 90),
    maxBytes: gib === null ? null : Number.isFinite(gib) && gib > 0 ? Math.round(gib * GIB) : NaN,
  };
});

const invalid = computed(
  () =>
    parsed.value.retentionDays === null ||
    parsed.value.maxPercent === null ||
    Number.isNaN(parsed.value.maxBytes)
);

const dirty = computed(
  () => JSON.stringify(local.value) !== JSON.stringify(fromSettings(current.value))
);

const saving = ref(false);
const saveError = ref('');

const save = async () => {
  if (invalid.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await appSettings.save({ trash: { ...parsed.value } });
    // The delete dialog and the sidebar read these; they follow at once.
    featuresStore.trashEnabled = parsed.value.enabled;
    featuresStore.trashRetentionDays = parsed.value.retentionDays;
  } catch (err) {
    saveError.value = err?.message || t('settings.trash.saveFailed');
  } finally {
    saving.value = false;
  }
};

const reset = () => {
  local.value = fromSettings(current.value);
};

const zones = ref([]);
const zonesLoading = ref(false);
const zonesError = ref('');
const verification = ref(null);
const verifying = ref(false);
const maintaining = ref(false);

const loadZones = async () => {
  zonesLoading.value = true;
  zonesError.value = '';
  try {
    const response = await getTrashZones();
    zones.value = Array.isArray(response?.zones) ? response.zones : [];
  } catch (err) {
    zonesError.value = err?.message || t('settings.trash.zonesFailed');
  } finally {
    zonesLoading.value = false;
  }
};

const verify = async () => {
  verifying.value = true;
  try {
    const response = await verifyTrash();
    verification.value = Array.isArray(response?.zones) ? response.zones : [];
  } catch (err) {
    zonesError.value = err?.message || t('settings.trash.verifyFailed');
  } finally {
    verifying.value = false;
  }
};

const runMaintenance = async () => {
  maintaining.value = true;
  try {
    await runTrashMaintenance();
    verification.value = null;
    await loadZones();
  } catch (err) {
    zonesError.value = err?.message || t('settings.trash.maintenanceFailed');
  } finally {
    maintaining.value = false;
  }
};

const zoneLabel = (zone) => {
  if (zone.kind === 'personal') return t('settings.trash.zoneKind.personal', { name: zone.name });
  if (zone.kind === 'user-volume')
    return t('settings.trash.zoneKind.userVolume', { name: zone.name });
  return zone.name;
};

const zoneState = (zone) =>
  zone.available
    ? t('settings.trash.available')
    : t(`settings.trash.unavailable.${zone.reason || 'missing'}`);

const usedShare = (zone) =>
  Number.isFinite(zone.budgetBytes) && zone.budgetBytes > 0
    ? Math.min(100, Math.round((zone.usedBytes / zone.budgetBytes) * 100))
    : 0;

const lastPassLabel = (zone) => {
  const pass = zone.lastPass;
  if (!pass) return t('settings.trash.never');
  const when = formatLocalDateTime(pass.at);
  const removed = pass.purged || 0;
  return `${when} · ${t('settings.trash.lastPassPurged', { count: removed }, removed)}`;
};

const eventLabel = (event) =>
  t(`settings.trash.events.${event.kind}`, { name: event.itemName || '' });

const violationsFor = (zone) =>
  verification.value?.find((result) => result.zoneId === zone.id)?.violations || null;

const totalViolations = computed(() =>
  (verification.value || []).reduce((total, result) => total + result.violations.length, 0)
);

onMounted(loadZones);
</script>

<template>
  <div class="space-y-6">
    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <span class="text-sm">{{ t('common.unsavedChanges') }}</span>
      <div class="flex gap-2">
        <button
          type="button"
          data-test="trash-settings-save"
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400 disabled:opacity-50"
          :disabled="invalid || saving"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
        <button
          type="button"
          class="rounded-md border border-current/20 px-3 py-1 hover:bg-white/10"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.trash.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.trash.subtitle') }}
      </p>
    </div>

    <section
      class="space-y-5 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.trash.enabled') }}
          </p>
          <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.enabledHelp') }}
          </p>
        </div>
        <ToggleSwitch v-model="local.enabled" data-test="trash-settings-enabled" />
      </div>

      <div class="grid gap-5 sm:grid-cols-3">
        <label class="block text-sm">
          <span class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.trash.retentionDays') }}
          </span>
          <input
            v-model="local.retentionDays"
            data-test="trash-settings-retention"
            type="number"
            min="1"
            max="3650"
            class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.retentionHelp') }}
          </span>
        </label>
        <label class="block text-sm">
          <span class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.trash.maxPercent') }}
          </span>
          <input
            v-model="local.maxPercent"
            data-test="trash-settings-percent"
            type="number"
            min="1"
            max="90"
            class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.maxPercentHelp') }}
          </span>
        </label>
        <label class="block text-sm">
          <span class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.trash.maxSize') }}
          </span>
          <input
            v-model="local.maxSizeGiB"
            data-test="trash-settings-size"
            type="text"
            inputmode="decimal"
            :placeholder="t('settings.trash.maxSizeNone')"
            class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.maxSizeHelp') }}
          </span>
        </label>
      </div>

      <p v-if="invalid" data-test="trash-settings-invalid" class="text-sm text-red-600">
        {{ t('settings.trash.invalid') }}
      </p>
      <p v-if="saveError" class="text-sm text-red-600">{{ saveError }}</p>
      <p class="text-xs text-zinc-500 dark:text-zinc-400">
        {{ t('settings.trash.environmentNote') }}
      </p>
    </section>

    <section
      class="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="font-medium text-zinc-900 dark:text-zinc-100">
            {{ t('settings.trash.zonesTitle') }}
          </h3>
          <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.zonesSubtitle') }}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            data-test="trash-settings-verify"
            class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            :disabled="verifying || zones.length === 0"
            @click="verify"
          >
            {{ verifying ? t('settings.trash.verifying') : t('settings.trash.verify') }}
          </button>
          <button
            type="button"
            data-test="trash-settings-maintenance"
            class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            :disabled="maintaining"
            @click="runMaintenance"
          >
            {{ maintaining ? t('settings.trash.running') : t('settings.trash.runMaintenance') }}
          </button>
        </div>
      </div>

      <p
        v-if="verification"
        data-test="trash-settings-verification"
        :class="totalViolations === 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'"
        class="text-sm"
      >
        {{
          totalViolations === 0
            ? t('settings.trash.verifyOk')
            : t('settings.trash.verifyIssues', { count: totalViolations }, totalViolations)
        }}
      </p>

      <p v-if="zonesError" class="text-sm text-red-600">{{ zonesError }}</p>
      <p v-else-if="!zonesLoading && zones.length === 0" class="text-sm text-zinc-500">
        {{ t('settings.trash.zonesEmpty') }}
      </p>

      <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
        <li v-for="zone in zones" :key="zone.id" data-trash-zone class="space-y-2 py-4">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="font-medium text-zinc-900 dark:text-zinc-100" data-trash-zone-name>
              {{ zoneLabel(zone) }}
            </p>
            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="
                zone.available
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
              "
              data-trash-zone-state
            >
              {{ zoneState(zone) }}
            </span>
          </div>
          <div
            v-if="zone.budgetBytes"
            class="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
            role="img"
            :aria-label="
              t('settings.trash.usage', {
                used: formatBytes(zone.usedBytes),
                budget: formatBytes(zone.budgetBytes),
              })
            "
          >
            <div class="h-full bg-amber-500" :style="{ width: `${usedShare(zone)}%` }"></div>
          </div>
          <p class="text-sm text-zinc-600 dark:text-zinc-400" data-trash-zone-usage>
            {{
              t(
                'settings.trash.zoneSummary',
                {
                  count: zone.itemCount,
                  used: formatBytes(zone.usedBytes),
                  budget: zone.budgetBytes
                    ? formatBytes(zone.budgetBytes)
                    : t('settings.trash.noBudget'),
                },
                zone.itemCount
              )
            }}
          </p>
          <p class="text-xs text-zinc-500 dark:text-zinc-400">
            {{ t('settings.trash.lastPass') }} {{ lastPassLabel(zone) }}
          </p>
          <ul
            v-if="violationsFor(zone)?.length"
            class="list-inside list-disc text-xs text-red-600"
            data-trash-zone-violations
          >
            <li v-for="(violation, index) in violationsFor(zone)" :key="index">
              {{ violation.invariant }} — {{ violation.detail }}
            </li>
          </ul>
          <details v-if="zone.events?.length" class="text-xs text-zinc-500 dark:text-zinc-400">
            <summary class="cursor-pointer">{{ t('settings.trash.events.title') }}</summary>
            <ul class="mt-2 space-y-1">
              <li v-for="event in zone.events" :key="event.id" data-trash-zone-event>
                {{ formatLocalDateTime(event.createdAt) }} — {{ eventLabel(event) }}
              </li>
            </ul>
          </details>
        </li>
      </ul>
    </section>
  </div>
</template>
