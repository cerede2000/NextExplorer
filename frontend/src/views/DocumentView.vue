<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTitle } from '@vueuse/core';

import { normalizePath } from '@/api';
import { usePreviewManager } from '@/plugins/preview/manager';
import { whenPreviewPluginsReady } from '@/plugins';
import PreviewHost from '@/plugins/preview/PreviewHost.vue';
import { useFileStore } from '@/stores/fileStore';
import { folderRoute } from '@/utils/folderRoute';
import { isEditableExtension } from '@/config/editor';

/**
 * One document, at an address of its own.
 *
 * Everything this page does, the folder listing also does — it is the same
 * preview, the same plugins, the same component. What it adds is the one thing
 * a panel over a folder cannot have: a URL. That is what lets a document be
 * opened in a browser tab, kept open while somebody browses elsewhere, opened
 * twice, linked to and bookmarked (nxzai/NextExplorer#303).
 *
 * Two things it has to get right, and both are about leaving:
 *
 * - closing the document must land somewhere, not on a blank page. It goes
 *   back to the folder the document is in, with the document selected, which
 *   is where closing the panel leaves you;
 * - closing the *tab* must tell the server the same thing closing the panel
 *   tells it. A tab gives one synchronous moment on its way out, so the close
 *   hook is told it is unloading and sends what it has to send in one beacon.
 *   Without it, a document closed by closing its tab would go on being
 *   reported as open by somebody who had left.
 */

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const previewManager = usePreviewManager();
const fileStore = useFileStore();

/** Nothing opened this, and nothing is going to. */
const nothingOpensIt = ref(false);

const documentPath = computed(() => {
  const raw = route.params.path;
  const joined = Array.isArray(raw) ? raw.join('/') : typeof raw === 'string' ? raw : '';
  return normalizePath(joined);
});

const name = computed(() => documentPath.value.split('/').filter(Boolean).pop() || '');
const parentPath = computed(() =>
  documentPath.value.split('/').filter(Boolean).slice(0, -1).join('/')
);

// The point of this page is that several of them are open at once, and four
// tabs all reading "Explorer" would be four tabs nobody can tell apart. The
// folder listing names its tab after the folder (BrowserLayout); this one
// names it after the document.
useTitle(name);

/** Back where closing the panel would have left you. */
const leave = () => {
  router.replace(folderRoute(parentPath.value, name.value ? { select: name.value } : undefined));
};

/**
 * The item a plugin is matched against.
 *
 * A path is all this page is given, and a path is all a plugin needs: the
 * manager works the extension out of the name when `kind` does not say.
 */
const itemFromPath = () => ({ name: name.value, path: parentPath.value });

const openDocument = async () => {
  nothingOpensIt.value = false;
  if (!documentPath.value || !name.value) {
    leave();
    return;
  }

  // The folder behind it, so that moving to the next image or the previous one
  // works here exactly as it does over the listing — the plugins read the
  // siblings from the file store. Best effort: a folder that cannot be listed
  // costs the arrows, not the document.
  void fileStore.fetchPathItems(parentPath.value).catch(() => {});

  // Waited for, because the editors register once the server has said they are
  // configured. Asking before that would answer "nothing opens this" about a
  // document ONLYOFFICE was a moment away from claiming.
  await whenPreviewPluginsReady();

  if (previewManager.open(itemFromPath())) return;

  // No preview: the text editor has its own page, and it is where this kind of
  // file opens from the listing too.
  const extension = name.value.includes('.') ? name.value.split('.').pop().toLowerCase() : '';
  if (isEditableExtension(extension)) {
    const encoded = documentPath.value.split('/').map(encodeURIComponent).join('/');
    router.replace({ path: `/editor/${encoded}` });
    return;
  }

  nothingOpensIt.value = true;
};

/**
 * The document closed itself — the button in its header, or Escape.
 *
 * Watched rather than passed as a callback because closing is the plugin's to
 * do: it may be asynchronous, and it may be refused. When the manager has let
 * go of it, this page has nothing left to show.
 */
watch(
  () => previewManager.isOpen,
  (open, wasOpen) => {
    if (wasOpen && !open) leave();
  }
);

/**
 * On the way out of the page, whatever took it there.
 *
 * `pagehide` and not `beforeunload`: it fires for a tab being closed, for a
 * navigation away, and on mobile browsers that never fire the other one.
 * Deliberately not `visibilitychange`, which fires every time somebody merely
 * switches to another tab — ending an editing session there would close a
 * document that is still open, which is the regression this whole thing exists
 * to avoid.
 */
const endBeforeUnload = () => {
  previewManager.endForUnload();
};

onMounted(() => {
  window.addEventListener('pagehide', endBeforeUnload);
  void openDocument();
});

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', endBeforeUnload);
  // Leaving this page inside the application is a close like any other: the
  // plugin gets the time it needs, and the session ends the ordinary way.
  if (previewManager.isOpen) void previewManager.close();
});

// A second document opened in the same tab — a link followed from inside one.
watch(documentPath, () => {
  void openDocument();
});
</script>

<template>
  <div class="flex h-full w-full flex-col bg-neutral-950">
    <PreviewHost />

    <!-- Only ever seen when nothing claimed the document: the preview itself
         covers the page. -->
    <div
      v-if="nothingOpensIt"
      class="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-test="document-unopenable"
    >
      <p class="text-sm text-neutral-300">{{ t('preview.nothingOpensIt', { name }) }}</p>
      <button
        type="button"
        class="rounded-md border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
        data-test="document-back"
        @click="leave"
      >
        {{ t('preview.backToFolder') }}
      </button>
    </div>
  </div>
</template>
