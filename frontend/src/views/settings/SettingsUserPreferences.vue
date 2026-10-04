<script setup>
import { computed, onMounted, provide, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppSettings } from '@/stores/appSettings';
import { useFeaturesStore } from '@/stores/features';
import { useI18n } from 'vue-i18n';
import {
  ArrowUpIcon,
  ArrowDownIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/vue/20/solid';
import {
  ArrowDownTrayIcon,
  Bars3Icon,
  BoltIcon,
  DocumentTextIcon,
  EyeIcon,
  HomeIcon,
  Squares2X2Icon,
} from '@heroicons/vue/24/outline';
import { languageLabel, supportedLocaleOptions } from '@/i18n';
import { useQuickActionsStore } from '@/stores/quickActions';
import { QUICK_ACTIONS_BY_ID } from '@/config/quickActions';
// The one speller for "text reduced to what a match should ignore" — the same
// one the folder's own typeahead reads a key through, so looking for
// "telechargement" finds "téléchargement" here exactly as it finds a file.
import { normalizeTypeaheadText } from '@/utils/folderKeyboard';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import PreferenceRow from './components/PreferenceRow.vue';
import SettingsSection from './components/SettingsSection.vue';

const appSettings = useAppSettings();
const features = useFeaturesStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

// Inline quick-actions menu config is a client-side (localStorage) preference,
// applied instantly — it is not part of the server-saved settings above.
const quickActions = useQuickActionsStore();
const quickActionLabel = (id) => {
  const meta = QUICK_ACTIONS_BY_ID[id];
  return meta ? t(meta.labelKey) : id;
};

/**
 * Every preference this screen sends, and what it is when nobody has chosen.
 *
 * One list, read by the four things that used to each hold their own copy:
 * filling the form from what is stored, deciding whether anything has changed,
 * putting it back the way it was, and sending it. Three of those copies agreed
 * and the fourth did not — `reset` had been written out by hand and was three
 * preferences short, so discarding a change to any of those three discarded
 * nothing: the switch stayed where it had been put, the bar kept saying there
 * was something to save, and the next save wrote it.
 *
 * The default matters as much as the key. It is the value the *server* reads an
 * absent preference as, so a switch that starts anywhere else disagrees with
 * what the listings are already doing, and turning it to what is actually
 * happening would save nothing — nothing changed.
 */
const FIELDS = [
  { key: 'locale', fallback: null },
  { key: 'defaultView', fallback: null },
  { key: 'foldersFirst', fallback: true },
  { key: 'showThumbnails', fallback: true },
  { key: 'showHiddenFiles', fallback: false },
  { key: 'showVersionMarks', fallback: true },
  { key: 'markdownOpensInEditor', fallback: false },
  { key: 'documentsOpenInNewTab', fallback: false },
  { key: 'browseInTabs', fallback: false },
  { key: 'closeTabsOnDoubleClick', fallback: false },
  // On unless it is turned off: a tab opened in the background is opened in order
  // not to wait for it.
  { key: 'preloadBackgroundTabs', fallback: true },
  { key: 'showSidebarFavorites', fallback: true },
  { key: 'showSidebarShares', fallback: true },
  { key: 'showSidebarTools', fallback: true },
  // null = use env, true/false = override
  { key: 'skipHome', fallback: null },
  { key: 'reopenTabs', fallback: false },
  { key: 'downloadMode', fallback: 'zip' },
];

/**
 * The themes, in the order the screen draws them and the index lists them.
 *
 * Twenty preferences in one unbroken column asked somebody looking for one of
 * them to read all twenty. Named groups, and a list of the names beside them
 * that goes straight to one.
 */
const SECTIONS = [
  { name: 'display', icon: EyeIcon },
  { name: 'documents', icon: DocumentTextIcon },
  { name: 'tabs', icon: Squares2X2Icon },
  { name: 'sidebar', icon: Bars3Icon },
  { name: 'start', icon: HomeIcon },
  { name: 'transfers', icon: ArrowDownTrayIcon },
  { name: 'quickActions', icon: BoltIcon },
];

const sectionTitle = (name) => t(`settings.userPreferences.sections.${name}`);

/** One spelling of a list to choose from, where there were seven copies. */
const selectClasses =
  'rounded-md border border-zinc-300 bg-white p-2 text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100';

/**
 * What each row is called and what it says, and which theme it belongs to.
 *
 * Here rather than in the markup because two other things read it: the filter,
 * which has to know the words a row shows before deciding whether it matches,
 * and the rows that are nothing but a switch, which the section draws from this
 * list rather than spelling out. A row carrying anything else — a list to
 * choose from, a number and a unit — keeps its own markup and is named here
 * all the same.
 *
 * `switch` is also the name a test reaches the row by. The names are the ones
 * the browser journey already uses.
 */
const ROWS = [
  {
    key: 'locale',
    section: 'display',
    label: 'i18n.language',
    help: 'settings.userPreferences.languageHelp',
  },
  {
    key: 'defaultView',
    section: 'display',
    label: 'settings.userPreferences.defaultView',
    help: 'settings.userPreferences.defaultViewHelp',
  },
  {
    key: 'foldersFirst',
    section: 'display',
    switch: 'folders-first',
    label: 'settings.userPreferences.foldersFirst',
    help: 'settings.userPreferences.foldersFirstHelp',
  },
  {
    key: 'showThumbnails',
    section: 'display',
    switch: 'show-thumbnails',
    label: 'settings.userPreferences.showThumbnails',
    help: 'settings.userPreferences.showThumbnailsHelp',
  },
  {
    key: 'showHiddenFiles',
    section: 'display',
    switch: 'show-hidden-files',
    label: 'settings.userPreferences.showHiddenFiles',
    help: 'settings.userPreferences.showHiddenFilesHelp',
  },
  {
    key: 'showVersionMarks',
    section: 'display',
    switch: 'show-version-marks',
    label: 'settings.userPreferences.showVersionMarks',
    help: 'settings.userPreferences.showVersionMarksHelp',
  },
  {
    key: 'markdownOpensInEditor',
    section: 'documents',
    switch: 'markdown-opens-in-editor',
    label: 'settings.userPreferences.markdownOpensInEditor',
    help: 'settings.userPreferences.markdownOpensInEditorHelp',
  },
  {
    key: 'documentsOpenInNewTab',
    section: 'documents',
    switch: 'documents-in-new-tab',
    label: 'settings.userPreferences.documentsOpenInNewTab',
    help: 'settings.userPreferences.documentsOpenInNewTabHelp',
  },
  {
    key: 'browseInTabs',
    section: 'tabs',
    switch: 'browse-in-tabs',
    label: 'settings.userPreferences.browseInTabs',
    help: 'settings.userPreferences.browseInTabsHelp',
  },
  {
    key: 'closeTabsOnDoubleClick',
    section: 'tabs',
    switch: 'close-tabs-on-double-click',
    label: 'settings.userPreferences.closeTabsOnDoubleClick',
    help: 'settings.userPreferences.closeTabsOnDoubleClickHelp',
  },
  {
    key: 'preloadBackgroundTabs',
    section: 'tabs',
    switch: 'preload-background-tabs',
    label: 'settings.userPreferences.preloadBackgroundTabs',
    help: 'settings.userPreferences.preloadBackgroundTabsHelp',
  },
  {
    key: 'showSidebarFavorites',
    section: 'sidebar',
    switch: 'show-sidebar-favorites',
    label: 'settings.userPreferences.showSidebarFavorites',
    help: 'settings.userPreferences.showSidebarFavoritesHelp',
  },
  {
    key: 'showSidebarShares',
    section: 'sidebar',
    switch: 'show-sidebar-shares',
    label: 'settings.userPreferences.showSidebarShares',
    help: 'settings.userPreferences.showSidebarSharesHelp',
  },
  {
    key: 'showSidebarTools',
    section: 'sidebar',
    switch: 'show-sidebar-tools',
    label: 'settings.userPreferences.showSidebarTools',
    help: 'settings.userPreferences.showSidebarToolsHelp',
  },
  {
    key: 'skipHome',
    section: 'start',
    label: 'settings.userPreferences.skipHome',
    help: 'settings.userPreferences.skipHomeHelp',
  },
  {
    key: 'reopenTabs',
    section: 'start',
    switch: 'reopen-tabs',
    label: 'settings.userPreferences.reopenTabs',
    help: 'settings.userPreferences.reopenTabsHelp',
  },
  {
    key: 'downloadMode',
    section: 'transfers',
    label: 'settings.userPreferences.downloadMode',
    help: 'settings.userPreferences.downloadModeHelp',
  },
  {
    key: 'defaultShareExpiration',
    section: 'transfers',
    label: 'settings.userPreferences.defaultShareExpiration',
    help: 'settings.userPreferences.defaultShareExpirationHelp',
  },
  {
    key: 'quickActions',
    section: 'quickActions',
    label: 'settings.userPreferences.quickActions',
    help: 'settings.userPreferences.quickActionsHelp',
  },
];

const ROW_BY_KEY = new Map(ROWS.map((row) => [row.key, row]));
const rowFor = (key) => ROW_BY_KEY.get(key);
const labelOf = (key) => t(rowFor(key).label);
const helpOf = (key, params) => t(rowFor(key).help, params || {});

const local = reactive({
  defaultShareExpirationValue: null,
  defaultShareExpirationUnit: 'weeks',
  ...Object.fromEntries(FIELDS.map(({ key, fallback }) => [key, fallback])),
});

/** The stored expiration, as the two fields on screen. */
const readStored = (stored) => {
  for (const { key, fallback } of FIELDS) {
    local[key] = stored?.[key] ?? fallback;
  }
  const expiration = stored?.defaultShareExpiration;
  local.defaultShareExpirationValue = expiration?.value ?? null;
  local.defaultShareExpirationUnit = expiration?.unit ?? 'weeks';
};

/** And the other way: the two fields on screen, as the server stores them. */
const expirationChosen = () =>
  local.defaultShareExpirationValue
    ? { value: local.defaultShareExpirationValue, unit: local.defaultShareExpirationUnit }
    : null;

const dirty = computed(() => {
  const stored = appSettings.userSettings;
  const changed = FIELDS.some(({ key, fallback }) => local[key] !== (stored?.[key] ?? fallback));
  if (changed) return true;
  return (
    JSON.stringify(expirationChosen()) !== JSON.stringify(stored?.defaultShareExpiration ?? null)
  );
});

// Empty means no default. Anything else has to be a whole number of at least
// one, as the server takes it: minus three weeks used to be sent as it was.
const expirationInvalid = computed(() => {
  const value = local.defaultShareExpirationValue;
  if (value === null || value === '') return false;
  return !(Number.isInteger(value) && value >= 1);
});

const hiddenFilePatternsLabel = computed(() => {
  const patterns = Array.isArray(features.hiddenFilePatterns) ? features.hiddenFilePatterns : [];
  return patterns.length ? patterns.join(', ') : t('common.disabled');
});

onMounted(() => {
  features.ensureLoaded();
});

// Named in their own language, so somebody looking for theirs finds it even
// when the page is in one they do not read.
const languages = supportedLocaleOptions.map(({ code }) => ({
  code,
  label: languageLabel(code),
}));

watch(() => appSettings.userSettings, readStored, { immediate: true });

const reset = () => readStored(appSettings.userSettings);

const save = async () => {
  if (expirationInvalid.value) return;
  await appSettings.save({
    user: {
      ...Object.fromEntries(FIELDS.map(({ key }) => [key, local[key]])),
      defaultShareExpiration: expirationChosen(),
    },
  });
};

/**
 * Narrowing twenty preferences down to the one somebody has in mind.
 *
 * Matched against what a row *shows* — its label and the sentence under it, in
 * the reader's own language — rather than against the key it is stored under,
 * which nobody outside this file has ever seen. Case and accents are folded by
 * the same function the folder's typeahead uses.
 */
const filter = ref('');
const wanted = computed(() => normalizeTypeaheadText(filter.value).trim());

const rowMatches = (key) => {
  if (!wanted.value) return true;
  const row = rowFor(key);
  return normalizeTypeaheadText(`${t(row.label)} ${t(row.help, {})}`).includes(wanted.value);
};

const sectionMatches = (name) =>
  !wanted.value || ROWS.some((row) => row.section === name && rowMatches(row.key));

const switchesIn = (name) =>
  ROWS.filter((row) => row.section === name && row.switch && rowMatches(row.key));

const nothingMatches = computed(
  () => Boolean(wanted.value) && !SECTIONS.some(({ name }) => sectionMatches(name))
);

/**
 * Where the reader asked to be, and how to get them there.
 *
 * The sections hand their own element over as they mount — see
 * components/SettingsSection.vue — so nothing here looks one up by id, which
 * would be ambiguous in a window drawing this screen in both panes at once.
 */
const boxes = new Map();
provide('settingsSections', {
  hold: (name, element) => boxes.set(name, element),
  release: (name) => boxes.delete(name),
});

const chosen = ref('');

/**
 * Go to a theme — or do nothing, which is the answer for a theme that is not
 * on screen.
 *
 * Guarded on the box rather than on the list of names, because the box is what
 * this needs: an address naming nothing, and an address naming a theme the
 * filter has hidden, are the same situation from here. The sections register as
 * they mount, and a child mounts before its parent, so by the time this runs on
 * arrival they are all in hand.
 */
const show = (name, { quiet = false } = {}) => {
  const box = boxes.get(name);
  if (!box) return;
  chosen.value = name;
  if (!quiet) router.replace({ hash: `#${name}` });
  // `?.` on the call: jsdom has none, and the rest of this application reads
  // its absence the same way.
  box.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
};

// An address naming a theme opens on it. The index writes that address when it
// is used, so the page somebody is looking at is the page they can send.
onMounted(() => show(String(route.hash || '').slice(1), { quiet: true }));
</script>

<template>
  <div class="space-y-4">
    <div
      v-if="dirty"
      class="sticky top-0 z-20 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/95 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-900/80 dark:text-yellow-100"
    >
      <div class="text-sm">{{ t('common.unsavedChanges') }}</div>
      <div class="flex gap-2">
        <button
          type="button"
          data-test="preferences-save"
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400 disabled:opacity-50"
          :disabled="expirationInvalid"
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
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.userPreferences.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('settings.userPreferences.subtitle') }}
      </p>
    </div>

    <!--
      `grid-cols-1` and not simply `grid`: a grid with no columns declared gets
      one automatic track, and an automatic track is sized by what is in it. The
      index below is a row of seven entries that scrolls inside itself on a
      narrow screen — its *max* content is nine hundred pixels wide — and the
      track took that width on a telephone. Everything beside it came along:
      the sections grew to nine hundred pixels inside a panel that clips, and
      every switch on this screen sat off the right-hand edge where nothing
      could reach it. `grid-cols-1` is `minmax(0, 1fr)`, which is the width
      there is.
    -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
      <!--
        The themes, and a way to narrow them down.

        A row of entries that scrolls sideways on a narrow screen and a column
        on a wide one, which is what the settings navigation beside it already
        does. It sticks to the top of the panel that scrolls, so the way to
        another theme is wherever the reader has got to.
      -->
      <div class="md:sticky md:top-0 md:self-start">
        <label class="relative block">
          <MagnifyingGlassIcon
            class="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          />
          <input
            v-model="filter"
            type="search"
            data-test="preferences-filter"
            :placeholder="t('settings.userPreferences.filter')"
            :aria-label="t('settings.userPreferences.filter')"
            class="w-full rounded-md border border-zinc-300 bg-white py-2 pl-7 pr-2 text-sm text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </label>
        <nav
          class="mt-3 flex gap-2 overflow-x-auto pb-1 md:flex-col md:gap-1 md:overflow-visible md:pb-0"
          :aria-label="t('settings.userPreferences.jumpTo')"
        >
          <button
            v-for="section in SECTIONS"
            :key="section.name"
            type="button"
            :data-test="`preferences-jump-${section.name}`"
            class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-600 transition enabled:hover:bg-zinc-100 disabled:opacity-40 md:shrink dark:text-zinc-300 dark:enabled:hover:bg-zinc-800"
            :class="
              chosen === section.name && sectionMatches(section.name)
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'
                : ''
            "
            :aria-current="
              chosen === section.name && sectionMatches(section.name) ? 'true' : undefined
            "
            :disabled="!sectionMatches(section.name)"
            @click="show(section.name)"
          >
            <component :is="section.icon" class="h-5 w-5 shrink-0" />
            <span class="truncate">{{ sectionTitle(section.name) }}</span>
          </button>
        </nav>
      </div>

      <div class="min-w-0 space-y-4">
        <p
          v-if="nothingMatches"
          data-test="preferences-no-match"
          class="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          {{ t('settings.userPreferences.noMatch', { text: filter }) }}
        </p>

        <SettingsSection
          v-if="sectionMatches('display')"
          name="display"
          :title="sectionTitle('display')"
        >
          <PreferenceRow
            v-if="rowMatches('locale')"
            :label="labelOf('locale')"
            :help="helpOf('locale')"
          >
            <select v-model="local.locale" data-test="preferences-language" :class="selectClasses">
              <option :value="null">{{ t('i18n.followBrowser') }}</option>
              <option v-for="language in languages" :key="language.code" :value="language.code">
                {{ language.label }}
              </option>
            </select>
          </PreferenceRow>

          <PreferenceRow
            v-if="rowMatches('defaultView')"
            :label="labelOf('defaultView')"
            :help="helpOf('defaultView')"
          >
            <select
              v-model="local.defaultView"
              data-test="preferences-default-view"
              :class="selectClasses"
            >
              <option :value="null">{{ t('settings.userPreferences.viewGrid') }}</option>
              <option value="list">{{ t('settings.userPreferences.viewList') }}</option>
              <option value="tab">{{ t('settings.userPreferences.viewColumns') }}</option>
              <option value="photos">{{ t('settings.userPreferences.viewPhotos') }}</option>
            </select>
          </PreferenceRow>

          <PreferenceRow
            v-for="row in switchesIn('display')"
            :key="row.key"
            :label="t(row.label)"
            :help="t(row.help, { patterns: hiddenFilePatternsLabel })"
          >
            <ToggleSwitch v-model="local[row.key]" :data-test="row.switch" />
          </PreferenceRow>
        </SettingsSection>

        <SettingsSection
          v-if="sectionMatches('documents')"
          name="documents"
          :title="sectionTitle('documents')"
        >
          <PreferenceRow
            v-for="row in switchesIn('documents')"
            :key="row.key"
            :label="t(row.label)"
            :help="t(row.help)"
          >
            <ToggleSwitch v-model="local[row.key]" :data-test="row.switch" />
          </PreferenceRow>
        </SettingsSection>

        <SettingsSection v-if="sectionMatches('tabs')" name="tabs" :title="sectionTitle('tabs')">
          <PreferenceRow
            v-for="row in switchesIn('tabs')"
            :key="row.key"
            :label="t(row.label)"
            :help="t(row.help)"
          >
            <ToggleSwitch v-model="local[row.key]" :data-test="row.switch" />
          </PreferenceRow>
        </SettingsSection>

        <SettingsSection
          v-if="sectionMatches('sidebar')"
          name="sidebar"
          :title="sectionTitle('sidebar')"
        >
          <PreferenceRow
            v-for="row in switchesIn('sidebar')"
            :key="row.key"
            :label="t(row.label)"
            :help="t(row.help)"
          >
            <ToggleSwitch v-model="local[row.key]" :data-test="row.switch" />
          </PreferenceRow>
        </SettingsSection>

        <SettingsSection v-if="sectionMatches('start')" name="start" :title="sectionTitle('start')">
          <PreferenceRow
            v-if="rowMatches('skipHome')"
            :label="labelOf('skipHome')"
            :help="helpOf('skipHome')"
          >
            <select v-model="local.skipHome" data-test="preferences-start" :class="selectClasses">
              <option :value="null">{{ t('settings.userPreferences.useEnvSetting') }}</option>
              <option :value="true">{{ t('common.enabled') }}</option>
              <option :value="false">{{ t('common.disabled') }}</option>
            </select>
          </PreferenceRow>

          <PreferenceRow
            v-for="row in switchesIn('start')"
            :key="row.key"
            :label="t(row.label)"
            :help="t(row.help)"
          >
            <ToggleSwitch v-model="local[row.key]" :data-test="row.switch" />
          </PreferenceRow>
        </SettingsSection>

        <SettingsSection
          v-if="sectionMatches('transfers')"
          name="transfers"
          :title="sectionTitle('transfers')"
        >
          <PreferenceRow
            v-if="rowMatches('downloadMode')"
            :label="labelOf('downloadMode')"
            :help="helpOf('downloadMode')"
          >
            <select
              v-model="local.downloadMode"
              data-test="preferences-download-mode"
              :class="selectClasses"
            >
              <option value="zip">{{ t('settings.userPreferences.downloadModeZip') }}</option>
              <option value="separate">
                {{ t('settings.userPreferences.downloadModeSeparate') }}
              </option>
            </select>
          </PreferenceRow>

          <PreferenceRow
            v-if="rowMatches('defaultShareExpiration')"
            :label="labelOf('defaultShareExpiration')"
            :help="helpOf('defaultShareExpiration')"
          >
            <template #note>
              <p
                v-if="expirationInvalid"
                data-test="expiration-invalid"
                class="mt-1 text-sm text-red-600"
              >
                {{ t('settings.userPreferences.defaultShareExpirationInvalid') }}
              </p>
            </template>
            <input
              v-model.number="local.defaultShareExpirationValue"
              type="number"
              min="1"
              :placeholder="t('settings.userPreferences.expirationValue')"
              class="w-20 rounded-md border border-zinc-300 bg-white p-2 text-center text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <select
              v-model="local.defaultShareExpirationUnit"
              data-test="preferences-expiry-unit"
              :class="selectClasses"
            >
              <option value="days">{{ t('settings.userPreferences.days') }}</option>
              <option value="weeks">{{ t('settings.userPreferences.weeks') }}</option>
              <option value="months">{{ t('settings.userPreferences.months') }}</option>
            </select>
            <button
              v-if="local.defaultShareExpirationValue"
              type="button"
              class="p-1 text-zinc-400 transition-colors hover:text-red-600 dark:hover:text-red-400"
              :title="t('common.clear')"
              @click="local.defaultShareExpirationValue = null"
            >
              <XMarkIcon class="h-5 w-5" />
            </button>
          </PreferenceRow>
        </SettingsSection>

        <!-- Inline quick-actions menu (client-side preference, applied instantly) -->
        <SettingsSection
          v-if="sectionMatches('quickActions')"
          name="quickActions"
          :title="sectionTitle('quickActions')"
        >
          <PreferenceRow :label="labelOf('quickActions')" :help="helpOf('quickActions')">
            <ToggleSwitch
              data-test="quick-actions"
              :model-value="quickActions.enabled"
              @update:model-value="quickActions.setEnabled"
            />
          </PreferenceRow>

          <div v-if="quickActions.enabled" class="mt-4">
            <div class="mb-4 flex items-center justify-between gap-4">
              <div class="text-sm text-zinc-700 dark:text-zinc-300">
                {{ t('settings.userPreferences.quickActionsMode') }}
              </div>
              <select
                :value="quickActions.displayMode"
                :class="selectClasses"
                @change="quickActions.setDisplayMode($event.target.value)"
              >
                <option value="full">
                  {{ t('settings.userPreferences.quickActionsModeFull') }}
                </option>
                <option value="compact">
                  {{ t('settings.userPreferences.quickActionsModeCompact') }}
                </option>
              </select>
            </div>
            <div class="mb-4 flex items-start justify-between gap-4">
              <div>
                <div class="text-sm text-zinc-700 dark:text-zinc-300">
                  {{ t('settings.userPreferences.quickActionsPosition') }}
                </div>
                <div class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {{ t('settings.userPreferences.quickActionsPositionHelp') }}
                </div>
              </div>
              <select
                :value="quickActions.position"
                data-test="preferences-quick-actions-position"
                class="shrink-0"
                :class="selectClasses"
                @change="quickActions.setPosition($event.target.value)"
              >
                <option value="after">
                  {{ t('settings.userPreferences.quickActionsPositionAfter') }}
                </option>
                <option value="start">
                  {{ t('settings.userPreferences.quickActionsPositionStart') }}
                </option>
                <option value="end">
                  {{ t('settings.userPreferences.quickActionsPositionEnd') }}
                </option>
              </select>
            </div>
            <div class="mb-2 flex items-center justify-between">
              <div class="text-sm text-zinc-500 dark:text-zinc-400">
                {{ t('settings.userPreferences.quickActionsReorder') }}
              </div>
              <button
                type="button"
                class="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                @click="quickActions.reset()"
              >
                {{ t('common.reset') }}
              </button>
            </div>
            <ul class="divide-y divide-zinc-100 dark:divide-zinc-800">
              <li
                v-for="(entry, index) in quickActions.config"
                :key="entry.id"
                class="flex items-center gap-3 py-2"
              >
                <div class="flex flex-col">
                  <button
                    type="button"
                    class="rounded p-0.5 text-zinc-400 hover:text-zinc-800 disabled:opacity-30 dark:hover:text-zinc-100"
                    :disabled="index === 0"
                    :aria-label="t('common.moveUp')"
                    @click="quickActions.move(entry.id, -1)"
                  >
                    <ArrowUpIcon class="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    class="rounded p-0.5 text-zinc-400 hover:text-zinc-800 disabled:opacity-30 dark:hover:text-zinc-100"
                    :disabled="index === quickActions.config.length - 1"
                    :aria-label="t('common.moveDown')"
                    @click="quickActions.move(entry.id, 1)"
                  >
                    <ArrowDownIcon class="h-4 w-4" />
                  </button>
                </div>
                <span class="flex-1 text-sm text-zinc-800 dark:text-zinc-200">
                  {{ quickActionLabel(entry.id) }}
                </span>
                <ToggleSwitch
                  size="sm"
                  :model-value="entry.on"
                  @update:model-value="(value) => quickActions.setActionOn(entry.id, value)"
                />
              </li>
            </ul>
          </div>
        </SettingsSection>
      </div>
    </div>
  </div>
</template>
