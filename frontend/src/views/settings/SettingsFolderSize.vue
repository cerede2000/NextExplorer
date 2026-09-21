<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';
import ExcludedPathsSettings from './ExcludedPathsSettings.vue';

const featuresStore = useFeaturesStore();
const appSettings = useAppSettings();
const { t } = useI18n();

// The page was reachable and fully editable with folder sizes switched off,
// which meant a list could be curated for a feature that was not running and
// nothing on the page said so.
const mode = computed(() => featuresStore.folderSizeMode || 'off');
const active = computed(() => mode.value !== 'off');

// Three positions rather than a switch: counting a folder's own entries and
// counting everything under it are different answers, and the choice between
// them is the one decision this feature asks for. FOLDER_SIZE_MODE, when set,
// makes it for everyone and the control shows it (#9).
const MODES = ['off', 'shallow', 'full'];
const modeLabel = (value) =>
  t(`settings.folderSize.mode${value.charAt(0).toUpperCase()}${value.slice(1)}`);

const lockedBy = computed(() => featuresStore.folderSizeLockedBy || null);
const saving = ref(false);

const setMode = async (next) => {
  if (lockedBy.value || saving.value || next === mode.value) return;
  saving.value = true;
  try {
    await appSettings.save({ folderSize: { mode: next } });
    featuresStore.folderSizeMode = next;
    featuresStore.folderSizeEnabled = next !== 'off';
  } catch {
    // The store keeps the error for the page; the choice stays where it was.
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <ExcludedPathsSettings
    settings-key="folderSize"
    translation-prefix="settings.folderSize"
    variable="FOLDER_SIZE_MODE"
    value="full"
    :active="active"
    :locked-by="lockedBy"
  >
    <template #control>
      <select
        class="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        :value="mode"
        :disabled="Boolean(lockedBy) || saving"
        :aria-label="t('settings.folderSize.running')"
        data-testid="folder-size-mode"
        @change="setMode($event.target.value)"
      >
        <option v-for="value in MODES" :key="value" :value="value">{{ modeLabel(value) }}</option>
      </select>
    </template>
  </ExcludedPathsSettings>
</template>
