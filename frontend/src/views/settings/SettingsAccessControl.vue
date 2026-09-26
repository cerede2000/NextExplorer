<script setup>
import { reactive, computed, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';

const appSettings = useAppSettings();
const { t } = useI18n();

const local = reactive({ rules: [], applyToAdmins: false });
const original = computed(() => ({
  rules: appSettings.state.access.rules,
  applyToAdmins: appSettings.state.access.applyToAdmins === true,
}));
const dirty = computed(
  () =>
    JSON.stringify(local.rules) !== JSON.stringify(original.value.rules) ||
    local.applyToAdmins !== original.value.applyToAdmins
);

watch(
  () => appSettings.state.access,
  (access) => {
    local.rules = (access?.rules || []).map((r) => ({ ...r }));
    local.applyToAdmins = access?.applyToAdmins === true;
  },
  { immediate: true, deep: true }
);

/**
 * With the setting on, every rule holds administrators whatever its own box
 * says, so each box is shown ticked and turned off rather than leaving a rule
 * looking as though it spared them.
 */
const holdsAdmins = (rule) => local.applyToAdmins || rule.appliesToAdmins === true;

const addRule = () => {
  local.rules.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2),
    path: '',
    recursive: true,
    permissions: 'ro',
    // Administrators keep their hands free unless somebody says otherwise,
    // which is what a read-only rule has always done.
    appliesToAdmins: false,
  });
};

const removeRule = (idx) => {
  local.rules.splice(idx, 1);
};
const reset = () => {
  local.rules = original.value.rules.map((r) => ({ ...r }));
  local.applyToAdmins = original.value.applyToAdmins;
};
const save = async () => {
  // basic sanitization client-side
  const cleaned = local.rules
    .map((r) => ({
      ...r,
      path: String(r.path || '').replace(/^\/+|\/+$/g, ''),
    }))
    .filter((r) => r.path);
  await appSettings.save({ access: { rules: cleaned, applyToAdmins: local.applyToAdmins } });
  local.rules = appSettings.state.access.rules.map((r) => ({ ...r }));
  local.applyToAdmins = appSettings.state.access.applyToAdmins === true;
};
</script>

<template>
  <div class="space-y-6">
    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <div class="text-sm">{{ t('common.unsavedChanges') }}</div>
      <div class="flex gap-2">
        <button
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
        <button
          class="rounded-md border border-white/10 px-3 py-1 hover:bg-white/10"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {{ t('titles.folderRules') }}
        </h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          {{ t('settings.access.subtitle') }}
        </p>
        <p
          class="mt-1 max-w-prose text-sm text-zinc-500 dark:text-zinc-400"
          data-test="access-admin-note"
        >
          {{ t('settings.access.adminNote') }}
        </p>
      </div>
      <button
        class="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-md hover:bg-zinc-800 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        @click="addRule"
      >
        {{ t('actions.addRule') }}
      </button>
    </div>

    <!-- One switch above the rules: on, no rule lets an administrator through. -->
    <label
      class="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <input
        v-model="local.applyToAdmins"
        type="checkbox"
        data-test="access-apply-to-admins"
        class="mt-0.5 h-4 w-4 rounded-sm border-zinc-300 text-zinc-600 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800"
      />
      <span class="text-sm">
        <span class="font-medium text-zinc-900 dark:text-zinc-100">
          {{ t('settings.access.applyToAdmins') }}
        </span>
        <span class="mt-1 block text-zinc-500 dark:text-zinc-400">
          {{ t('settings.access.applyToAdminsHint') }}
        </span>
      </span>
    </label>

    <!-- Content -->
    <div
      v-if="local.rules.length === 0"
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-12 text-center"
    >
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.access.noRules') || 'No access rules configured.' }}
      </p>
      <p class="text-xs mt-1 text-zinc-500 dark:text-zinc-400">
        {{ t('settings.access.noRulesHint') || 'Click "Add Rule" to create your first rule.' }}
      </p>
    </div>

    <div
      v-else
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden"
    >
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead
            class="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800"
          >
            <tr>
              <th class="px-6 py-3">{{ t('common.path') }}</th>
              <th class="px-6 py-3">{{ t('settings.access.recursive') }}</th>
              <th class="px-6 py-3">{{ t('settings.access.appliesToAdmins') }}</th>
              <th class="px-6 py-3">{{ t('common.permissions') }}</th>
              <th class="px-6 py-3 w-24"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
            <tr
              v-for="(rule, idx) in local.rules"
              :key="rule.id"
              class="hover:bg-zinc-50 dark:hover:bg-zinc-950/30 transition-colors"
            >
              <td class="px-6 py-4">
                <input
                  v-model="rule.path"
                  :placeholder="t('placeholders.path')"
                  class="block w-full rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border"
                />
              </td>
              <td class="px-6 py-4">
                <label class="inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    v-model="rule.recursive"
                    class="h-4 w-4 rounded-sm border-zinc-300 text-zinc-600 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800"
                  />
                </label>
              </td>
              <td class="px-6 py-4">
                <label
                  class="inline-flex items-center"
                  :class="local.applyToAdmins ? 'cursor-not-allowed' : 'cursor-pointer'"
                  :title="local.applyToAdmins ? t('settings.access.applyToAdminsHint') : ''"
                >
                  <input
                    type="checkbox"
                    :checked="holdsAdmins(rule)"
                    :disabled="local.applyToAdmins"
                    :data-test="`rule-applies-to-admins-${idx}`"
                    class="h-4 w-4 rounded-sm border-zinc-300 text-zinc-600 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800"
                    @change="rule.appliesToAdmins = $event.target.checked"
                  />
                </label>
              </td>
              <td class="px-6 py-4">
                <select
                  v-model="rule.permissions"
                  class="block w-full rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border"
                >
                  <option value="rw">
                    {{ t('settings.access.readWrite') }}
                  </option>
                  <option value="ro">
                    {{ t('settings.access.readOnly') }}
                  </option>
                  <option value="hidden">
                    {{ t('settings.access.hidden') }}
                  </option>
                </select>
              </td>
              <td class="px-6 py-4">
                <button
                  class="inline-flex items-center rounded-md border border-transparent bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 focus:outline-hidden focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40"
                  @click="removeRule(idx)"
                >
                  {{ t('common.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
