<template>
  <div class="flex h-full w-full flex-col bg-white dark:bg-default">
    <header
      class="sticky top-0 z-40 flex flex-wrap items-center gap-4 border-b border-neutral-200 bg-white/90 px-4 py-2 shadow-xs backdrop-blur dark:border-neutral-900 dark:bg-default"
    >
      <div class="min-w-0">
        <p class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {{
            isTrashViewer
              ? t('editor.trashReadOnly')
              : isVersionViewer
                ? t('editor.versionReadOnly')
                : isSharedReadOnly
                  ? t('common.readonly')
                  : t('editor.editing')
          }}
        </p>
        <h1 class="truncate text-md text-neutral-900 dark:text-white">
          {{ displayPath || '—' }}
        </h1>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span v-if="saveError" class="text-sm text-red-600 dark:text-red-400">
          {{ saveError }}
        </span>
        <p
          v-if="hasUnsavedChanges && !isViewerOnly"
          class="mr-4 text-xs text-amber-600 dark:text-amber-400"
        >
          {{ t('editor.unsavedChanges') }}
        </p>
        <button
          v-if="!isViewerOnly && (!isSharedEditor || sharedCanDownload)"
          type="button"
          @click="openRaw"
          :disabled="isLoading || !displayPath"
          class="rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white border dark:border-zinc-700"
          :title="t('editor.raw')"
        >
          {{ t('editor.raw') }}
        </button>
        <button
          v-if="isSharedEditor && sharedCanDownload"
          type="button"
          @click="openDownload"
          :disabled="isLoading || !displayPath"
          class="rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white border dark:border-zinc-700"
          :aria-label="t('share.directLinkModes.download')"
          :title="t('share.directLinkModes.download')"
        >
          {{ t('share.directLinkModes.download') }}
        </button>
        <div ref="themeMenuRef" class="relative">
          <button
            type="button"
            class="rounded-md p-1 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
            aria-haspopup="listbox"
            :aria-expanded="isThemeMenuOpen"
            :aria-label="`${t('editor.theme')}: ${currentThemeLabel}`"
            :title="`${t('editor.theme')}: ${currentThemeLabel}`"
            @click="isThemeMenuOpen = !isThemeMenuOpen"
          >
            <Color20Regular class="h-5 w-5" />
          </button>
          <div
            v-if="isThemeMenuOpen"
            class="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-800"
            role="listbox"
            :aria-label="t('editor.selectTheme')"
          >
            <div class="max-h-80 overflow-auto py-1">
              <button
                v-for="opt in themeOptions"
                :key="opt.id"
                type="button"
                role="option"
                :aria-selected="opt.id === themeId"
                class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                @click="updateTheme(opt.id)"
              >
                <span class="min-w-0 truncate">{{ opt.label }}</span>
                <span
                  v-if="opt.id === themeId"
                  class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent dark:bg-white/10 dark:text-white"
                >
                  {{ t('common.active') }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="!isViewerOnly && (!isSharedEditor || sharedCanWrite)"
          type="button"
          @click="saveFile"
          :disabled="!canSave"
          class="rounded-md p-1 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
          :aria-label="$t('common.save')"
          :title="$t('common.save')"
        >
          <ArrowPathIcon v-if="isSaving" class="h-6 w-6 animate-spin shrink-0" />
          <Save20Regular v-else class="h-6 w-6 shrink-0" />
        </button>

        <div ref="settingsMenuRef" class="relative">
          <button
            type="button"
            class="rounded-full p-1 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
            aria-haspopup="true"
            :aria-expanded="isSettingsMenuOpen"
            :aria-label="$t('editor.editorSettings')"
            :title="$t('editor.editorSettings')"
            @click="isSettingsMenuOpen = !isSettingsMenuOpen"
          >
            <EllipsisVerticalIcon class="h-5 w-5" />
          </button>
          <div
            v-if="isSettingsMenuOpen"
            class="absolute right-0 z-50 mt-2 w-32 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-800"
            role="menu"
          >
            <div class="py-1">
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                @click="toggleLineWrapping"
              >
                <span>{{ t('editor.wrapLines') }}</span>
                <CheckIcon v-if="isLineWrapping" class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          @click="requestClose"
          :disabled="isSaving"
          class="rounded-md p-1 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
          :aria-label="$t('common.close')"
          :title="$t('common.close')"
        >
          <XMarkIcon class="h-5 w-5" />
        </button>
      </div>
    </header>

    <section class="flex-1 min-h-0">
      <div
        v-if="isLoading"
        class="flex h-full items-center justify-center text-sm text-neutral-500 dark:text-neutral-400"
      >
        Loading file…
      </div>
      <div v-else-if="loadError" class="p-6 text-sm text-red-600 dark:text-red-400">
        {{ loadError }}
      </div>
      <div v-else class="flex h-full flex-col">
        <p
          v-if="highlightingOff"
          class="border-b border-neutral-200 px-4 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
          data-testid="editor-highlighting-off"
        >
          {{ t('editor.highlightingOffTooLarge') }}
        </p>
        <CodeSurface
          ref="surface"
          :content="loadedContent"
          :autofocus="true"
          :extensions="extensions"
          class="min-h-0 flex-1"
          @ready="handleReady"
          @edit="handleEdit"
          @dirty-change="(value) => (hasUnsavedChanges = value)"
        />
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, shallowRef, watch, computed } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Compartment, EditorState } from '@codemirror/state';
import CodeSurface from '@/components/editor/CodeSurface.vue';
import { longestBlockLength, longestLineLength } from '@/utils/textBlocks';
import {
  fetchFileContent,
  fetchSharedFileContent,
  saveFileContent,
  saveSharedFileContent,
  getRawFileUrl,
  getDirectShareFileUrl,
  getTrashFileText,
  getVersionText,
  normalizePath,
} from '@/api';
import { EditorView, keymap } from '@codemirror/view';
import * as themeBundle from '@fsegurai/codemirror-theme-bundle';
import {
  XMarkIcon,
  ArrowPathIcon,
  EllipsisVerticalIcon,
  CheckIcon,
} from '@heroicons/vue/24/outline';
import { Save20Regular, Color20Regular } from '@vicons/fluent';
import { onClickOutside, onKeyStroke, useLocalStorage } from '@vueuse/core';
import { useFolderScrollStore } from '@/stores/folderScroll';
import { useVersionsPanelStore } from '@/stores/versionsPanel';
import { usePageTitle } from '@/composables/usePageTitle';
import { fileTitleFor } from '@/utils/pageTitle';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const folderScrollStore = useFolderScrollStore();
const versionsPanel = useVersionsPanelStore();

// State
// The document as read. The text being edited lives in CodeMirror, and is
// taken from it once, when it is saved.
const loadedContent = shallowRef('');
const surface = ref(null);
const hasUnsavedChanges = ref(false);
const highlightingOff = ref(false);
const isLoading = ref(false);
const isSaving = ref(false);
const loadError = ref('');
const saveError = ref('');
const view = shallowRef(null);
const isThemeMenuOpen = ref(false);
const themeMenuRef = ref(null);
const isSettingsMenuOpen = ref(false);
const settingsMenuRef = ref(null);
// Off, as the editor starts: this said true while no line was wrapped, so the
// menu showed the option ticked and the first press appeared to do nothing.
const isLineWrapping = ref(false);
const sharedFileName = ref('');
const sharedCanDownload = ref(false);
const sharedCanWrite = ref(false);
const sharedDirectPath = ref('');
onClickOutside(themeMenuRef, () => {
  isThemeMenuOpen.value = false;
});
onClickOutside(settingsMenuRef, () => {
  isSettingsMenuOpen.value = false;
});

// Theme
const themeId = useLocalStorage('editor:theme', 'vsCodeDark');
const themeOptions = Object.keys(themeBundle)
  .filter((k) => !k.includes('Merge'))
  .map((k) => ({
    id: k,
    label: k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

const currentThemeLabel = computed(
  () => themeOptions.find((o) => o.id === themeId.value)?.label ?? themeId.value
);

// Editor Setup
const languageComp = new Compartment();
const themeComp = new Compartment();
const lineWrappingComp = new Compartment();
const readOnlyComp = new Compartment();
const customKeymap = keymap.of([
  {
    key: 'Alt-z',
    run: () => {
      toggleLineWrapping();
      return true;
    },
  },
]);

const extensions = [
  languageComp.of([]),
  themeComp.of(themeBundle[themeId.value] ?? themeBundle.githubDark),
  lineWrappingComp.of([]),
  readOnlyComp.of([]),
  customKeymap,
];

const handleReady = ({ view: v }) => {
  view.value = v;
};

const updateTheme = (id) => {
  themeId.value = id;
  isThemeMenuOpen.value = false;
  view.value?.dispatch({
    effects: themeComp.reconfigure(themeBundle[id] ?? themeBundle.githubDark),
  });
};

// File Info
const normalizedPath = computed(() =>
  normalizePath(
    Array.isArray(route.params.path) ? route.params.path.join('/') : route.params.path || ''
  )
);
const isSharedEditor = computed(() => route.name === 'SharedEditor');
const isSharedReadOnly = computed(() => isSharedEditor.value && !sharedCanWrite.value);
/**
 * A file in the trash, opened to be read before deciding what to do with it.
 * Never to be changed: no save, no shortcut that saves, an editor that does not
 * take typing, and leaving goes back to the trash it came from.
 */
const isTrashViewer = computed(() => route.name === 'TrashFileViewer');
/**
 * An earlier version of a file, opened from its history: read only for the same
 * reasons, and leaving goes back to the folder with the history open again.
 */
const isVersionViewer = computed(() => route.name === 'VersionFileViewer');
const isViewerOnly = computed(() => isTrashViewer.value || isVersionViewer.value);
const isReadOnly = computed(() => isSharedReadOnly.value || isViewerOnly.value);
const versionFileName = ref('');
const versionId = computed(() =>
  typeof route.params?.versionId === 'string' ? route.params.versionId : ''
);
const trashFileName = ref('');
const trashItemId = computed(() =>
  typeof route.params?.itemId === 'string' ? route.params.itemId : ''
);
const trashEntryPath = computed(() =>
  normalizePath(
    Array.isArray(route.params?.entryPath)
      ? route.params.entryPath.join('/')
      : route.params?.entryPath || ''
  )
);
const sharedToken = computed(() =>
  typeof route.params?.token === 'string' ? route.params.token : ''
);
const sharedPath = computed(() =>
  normalizePath(
    Array.isArray(route.params?.sharedPath)
      ? route.params.sharedPath.join('/')
      : route.params?.sharedPath || ''
  )
);
const displayPath = computed(() => {
  if (isTrashViewer.value) return trashFileName.value || trashEntryPath.value;
  if (isVersionViewer.value) return versionFileName.value || normalizedPath.value;
  return isSharedEditor.value ? sharedFileName.value || sharedPath.value : normalizedPath.value;
});
// The file's name in the tab, as a folder's is. It had none: opened directly the
// tab read "Explorer", and opened from a folder it kept that folder's name.
usePageTitle(computed(() => fileTitleFor(displayPath.value)));

const canSave = computed(
  () =>
    !isViewerOnly.value &&
    (!isSharedEditor.value || sharedCanWrite.value) &&
    hasUnsavedChanges.value &&
    !isSaving.value &&
    !isLoading.value &&
    !loadError.value
);

const parentFolderPath = () => {
  const parts = normalizedPath.value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
};

const routeFolderPath = (targetRoute) => {
  if (targetRoute?.name !== 'FolderView') return '';
  const raw = Array.isArray(targetRoute.params?.path)
    ? targetRoute.params.path.join('/')
    : targetRoute.params?.path || '';
  return normalizePath(raw);
};

// BrowserLayout is unmounted while editing text, so the generic folder-to-
// folder navigation rule cannot infer this return journey. Mark it directly
// from the editor before every exit, including the browser Back button.
onBeforeRouteLeave((to) => {
  const parent = parentFolderPath();
  if (parent && routeFolderPath(to) === parent) {
    folderScrollStore.permitExplicitRestore(parent);
  }
});

// Operations
const loadFile = async () => {
  const requestPath = route.fullPath;
  const path = normalizedPath.value;

  if (!isSharedEditor.value && !isTrashViewer.value && !path) {
    loadedContent.value = '';
    hasUnsavedChanges.value = false;
    return;
  }

  isLoading.value = true;
  loadError.value = '';
  saveError.value = '';
  trashFileName.value = '';
  versionFileName.value = '';
  sharedFileName.value = '';
  sharedCanDownload.value = false;
  sharedCanWrite.value = false;
  sharedDirectPath.value = '';

  try {
    let response;
    if (isTrashViewer.value) {
      response = await getTrashFileText(trashItemId.value, trashEntryPath.value);
    } else if (isVersionViewer.value) {
      response = await getVersionText(path, versionId.value);
    } else if (isSharedEditor.value) {
      response = await fetchSharedFileContent(sharedToken.value, sharedPath.value);
    } else {
      response = await fetchFileContent(path);
    }
    if (requestPath !== route.fullPath) return;

    trashFileName.value = isTrashViewer.value ? response.name || '' : '';
    versionFileName.value = isVersionViewer.value ? response.name || '' : '';
    sharedFileName.value = isSharedEditor.value ? response.name || '' : '';
    sharedCanDownload.value = Boolean(isSharedEditor.value && response.canDownload);
    sharedCanWrite.value = Boolean(isSharedEditor.value && response.canWrite);
    sharedDirectPath.value = isSharedEditor.value ? response.path || '' : '';
    loadedContent.value = response.content || '';
    hasUnsavedChanges.value = false;
    applyLanguage(displayPath.value);
  } catch (err) {
    if (requestPath !== route.fullPath) return;
    loadError.value = err.message;
  } finally {
    if (requestPath === route.fullPath) isLoading.value = false;
  }
};

const saveFile = async () => {
  // Nothing opened from the trash or from a file's history is ever written back.
  if (isViewerOnly.value) return;
  if (!canSave.value || (!isSharedEditor.value && !normalizedPath.value)) return;
  const doc = surface.value?.snapshot();
  if (!doc) return;
  // The only time the whole document becomes one string.
  const text = doc.toString();
  isSaving.value = true;
  saveError.value = '';
  try {
    if (isSharedEditor.value) {
      await saveSharedFileContent(sharedToken.value, sharedDirectPath.value, text);
    } else {
      await saveFileContent(normalizedPath.value, text);
    }
    // What was written, not what is on screen now: typing during the save is
    // still unsaved.
    surface.value?.markSaved(doc);
  } catch (err) {
    saveError.value = err.message;
  } finally {
    isSaving.value = false;
  }
};

const openRaw = () => {
  const url = isSharedEditor.value
    ? getDirectShareFileUrl(sharedToken.value, sharedDirectPath.value, 'raw')
    : normalizedPath.value
      ? getRawFileUrl(normalizedPath.value)
      : '';
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
};

const openDownload = () => {
  if (!isSharedEditor.value || !sharedCanDownload.value) return;
  const url = getDirectShareFileUrl(sharedToken.value, sharedDirectPath.value, 'download');
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
};

const requestClose = () => {
  if (isSaving.value) return;
  // Nothing read from the trash can be lost by leaving: it was never editable.
  if (
    !isViewerOnly.value &&
    hasUnsavedChanges.value &&
    !confirm(t('editor.confirmCloseWithoutSaving'))
  )
    return;

  // A tab opened for this file alone is closed rather than sent somewhere: the
  // preference that opens documents in their own tab sends editable files here
  // too, and leaving used to turn the tab into a second explorer (nxzai#303).
  //
  // A single history entry is what says the tab was opened for this and
  // nothing else — the tab somebody opened the whole application in is also
  // "created by web content", and closing that because they shut a file would
  // take the rest of their session with it. Closing is asynchronous, so the
  // ordinary way out still runs if the browser refuses.
  if (window.history.length === 1) {
    window.close();
    setTimeout(() => {
      if (!window.closed) leaveTheOrdinaryWay();
    }, CLOSE_REFUSED_AFTER_MS);
    return;
  }

  leaveTheOrdinaryWay();
};

const CLOSE_REFUSED_AFTER_MS = 150;

/** Where closing lands when this tab has somewhere to go back to. */
const leaveTheOrdinaryWay = () => {
  if (isSharedEditor.value) {
    router.replace(`/share/${encodeURIComponent(sharedToken.value)}`);
    return;
  }

  if (isVersionViewer.value) {
    // Back to the folder, with the file's history open where it was read from.
    versionsPanel.openPath(normalizedPath.value);
    const parent = parentFolderPath();
    router.replace(`/browse${parent ? '/' + parent : ''}`);
    return;
  }

  if (isTrashViewer.value) {
    // Back to the trash, in the deleted folder the file was read from.
    const segments = trashEntryPath.value.split('/').filter(Boolean);
    segments.pop();
    const query = {};
    if (trashEntryPath.value) query.item = trashItemId.value;
    if (segments.length) query.path = segments.join('/');
    router.replace({ name: 'Trash', query });
    return;
  }

  const parent = parentFolderPath();
  router.replace(`/browse${parent ? '/' + parent : ''}`);
};

/**
 * How long one Markdown block may be before the file is opened without
 * colouring.
 *
 * The Markdown parser reads a paragraph whole, in one go, once it ends. A
 * nineteen-megabyte file with no blank line in it is a single paragraph, and
 * reading it froze the page for five and a half seconds here, right after the
 * editor had opened; the same text as `.txt` opened in 36 ms. At that rate a
 * quarter of a megabyte is about 75 ms, which a page absorbs.
 */
const MARKDOWN_BLOCK_LIMIT = 256 * 1024;

/**
 * How long one line may be before a file in any other language is opened
 * without colouring. Those parsers divide a document by lines: a
 * nineteen-megabyte JSON file on one line held the page in jolts of up to
 * 220 ms for six seconds, about 170 ms frozen per megabyte of line. A line of
 * this length costs about ten, and nobody writes one by hand.
 */
const LONG_LINE_LIMIT = 64 * 1024;

/** Whether parsing this document for colours would hold the page. */
const tooLargeToColour = (desc, text) => {
  if (!desc) return false;
  return desc.name === 'Markdown'
    ? longestBlockLength(text) > MARKDOWN_BLOCK_LIMIT
    : longestLineLength(text) > LONG_LINE_LIMIT;
};

const applyLanguage = async (path) => {
  if (!view.value) return;
  const ext = path.split('.').pop().toLowerCase();

  try {
    const { languages } = await import('@codemirror/language-data');
    // Simplified matching: extension -> name -> fallback for frameworks
    let desc =
      languages.find((l) => l.extensions?.includes(ext) || l.name?.toLowerCase() === ext) ??
      (['vue', 'svelte', 'astro'].includes(ext) ? languages.find((l) => l.name === 'HTML') : null);

    highlightingOff.value = tooLargeToColour(desc, loadedContent.value);
    if (highlightingOff.value) desc = null;

    view.value.dispatch({
      effects: languageComp.reconfigure(desc ? await desc.load() : []),
    });
  } catch (e) {
    console.warn('Language error:', e);
  }
};

// Interaction
const toggleLineWrapping = () => {
  isLineWrapping.value = !isLineWrapping.value;
  view.value?.dispatch({
    effects: lineWrappingComp.reconfigure(isLineWrapping.value ? EditorView.lineWrapping : []),
  });
};

const updateReadOnlyMode = () => {
  view.value?.dispatch({
    effects: readOnlyComp.reconfigure(
      isReadOnly.value ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
    ),
  });
};

onKeyStroke('Escape', () =>
  isThemeMenuOpen.value ? (isThemeMenuOpen.value = false) : requestClose()
);
onKeyStroke(['s', 'S'], (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    saveFile();
  }
});

watch(
  [normalizedPath, isSharedEditor, sharedToken, sharedPath, trashItemId, trashEntryPath, versionId],
  loadFile,
  {
    immediate: true,
  }
);
watch(view, () => {
  updateReadOnlyMode();
  applyLanguage(displayPath.value);
});
watch([isSharedEditor, sharedCanWrite, isTrashViewer, isVersionViewer], updateReadOnlyMode);
function handleEdit() {
  if (saveError.value) saveError.value = '';
}
</script>
