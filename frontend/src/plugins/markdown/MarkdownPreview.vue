<!-- MarkdownPreview.vue -->
<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <div
      v-if="error"
      class="p-6 text-sm text-red-600 dark:text-red-400"
      data-testid="markdown-preview-error"
    >
      {{ error }}
    </div>
    <template v-else>
      <div
        v-if="rendering"
        class="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white/90 px-6 py-2 text-xs text-neutral-500 backdrop-blur dark:border-neutral-800 dark:bg-zinc-900/90 dark:text-neutral-400"
        data-testid="markdown-preview-progress"
      >
        <span
          class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        {{ $t('preview.stillRendering', { percent: renderedPercent }) }}
      </div>
      <article
        ref="container"
        class="markdown-preview prose prose-slate dark:prose-invert mx-auto w-full max-w-3xl flex-1 px-6 py-8"
      />
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import DOMPurify from 'dompurify';
import { useFeaturesStore } from '@/stores/features';
import { formatBytes } from '@/utils';

const props = defineProps({
  item: { type: Object, required: true },
  extension: { type: String, required: true },
  filePath: { type: String, required: true },
  previewUrl: { type: String, required: true },
  api: { type: Object, required: true },
});

const { t } = useI18n();
const featuresStore = useFeaturesStore();

const container = ref(null);
const error = ref('');
const rendering = ref(false);
const renderedPercent = ref(0);

/**
 * How much of a document the preview will render.
 *
 * Set by the server (`PREVIEW_MAX_RENDER_SIZE`) rather than fixed here. It was
 * fixed here, which meant someone who raised the editor's limit in good faith
 * was refused at a number that appeared in no setting and no document, and had
 * no way to find out where it came from.
 */
const DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

const maxPreviewBytes = computed(() =>
  Number.isFinite(featuresStore.previewMaxRenderBytes)
    ? featuresStore.previewMaxRenderBytes
    : DEFAULT_MAX_PREVIEW_BYTES
);

/**
 * Rendering a large document without stopping everything else.
 *
 * The editor opens the same file without trouble because CodeMirror puts only
 * the visible lines in the DOM. A preview has to produce the whole document,
 * and it used to do it in one synchronous stretch: marked walking the text,
 * DOMPurify parsing the HTML that produced and serialising it back, and the
 * browser parsing that string a third time before laying out every node. Three
 * full passes over a growing string, and six megabytes of markdown froze the
 * tab for as long as all of it took.
 *
 * Three changes, answering three different costs:
 *
 * - **A batch that measures itself.** Blocks are not equal — one table is
 *   worth a hundred one-line paragraphs — so a fixed count of them paces
 *   nothing. Each batch is timed and the next one sized from what the last
 *   cost, converging on a frame's worth of actual work. Timing the wrong half
 *   is the easy mistake here: collecting tokens costs microseconds, and a
 *   budget spent on that collects the entire document and renders it in one
 *   stretch, which is exactly the freeze this exists to prevent.
 * - **Sanitising straight into a fragment.** `RETURN_DOM_FRAGMENT` removes an
 *   entire parse of a multi-megabyte string, and the string with it.
 * - **`content-visibility: auto` per chunk.** The browser skips layout and
 *   paint for chunks that are off screen, which is what keeps scrolling smooth
 *   once the whole document exists. Unlike hiding them, the text stays
 *   findable: Ctrl+F still crosses the whole document, which is the reason
 *   this is not virtualised.
 */
const FRAME_BUDGET_MS = 12;
const INITIAL_BATCH_TOKENS = 32;
const MAX_BATCH_TOKENS = 2048;

const yieldToBrowser = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

let cancelled = false;
onBeforeUnmount(() => {
  cancelled = true;
});

/** One chunk of rendered markdown, and the hint that lets it be skipped. */
const appendChunk = (fragment) => {
  const section = document.createElement('section');
  // `auto` rather than a fixed height: the browser remembers what a chunk
  // measured once it has been on screen, so the scrollbar stops shifting under
  // the reader after the first pass over it.
  section.style.contentVisibility = 'auto';
  section.style.containIntrinsicSize = 'auto 600px';
  section.appendChild(fragment);
  container.value?.appendChild(section);
};

onMounted(async () => {
  rendering.value = true;
  error.value = '';

  try {
    const { marked } = await import('marked');
    const response = await props.api.fetchContent();
    const content = response?.content || '';

    if (content.length > maxPreviewBytes.value) {
      // Naming both numbers is the difference between an explanation and a
      // dead end: the editor's limit is a different setting over different
      // work, and someone who set that one deserves to be told so here.
      const editorLimit = featuresStore.editorMaxFileSizeBytes;
      error.value = editorLimit
        ? t('preview.tooLargeToRenderWithEditor', {
            size: formatBytes(content.length),
            limit: formatBytes(maxPreviewBytes.value),
            editorLimit: formatBytes(editorLimit),
          })
        : t('preview.tooLargeToRenderSized', {
            size: formatBytes(content.length),
            limit: formatBytes(maxPreviewBytes.value),
          });
      return;
    }

    const tokens = marked.lexer(content);
    const total = tokens.length;
    let index = 0;
    let batchSize = INITIAL_BATCH_TOKENS;

    while (index < total) {
      if (cancelled) return;

      const slice = tokens.slice(index, index + batchSize);
      // Reference-style links are collected by the lexer onto the token array
      // itself, so a slice of it has to carry them or `[text][ref]` renders as
      // literal brackets halfway down a document.
      slice.links = tokens.links;

      const startedAt = Date.now();
      const fragment = DOMPurify.sanitize(marked.parser(slice), {
        RETURN_DOM_FRAGMENT: true,
      });
      if (cancelled) return;
      appendChunk(fragment);
      const took = Date.now() - startedAt;

      index += slice.length;
      renderedPercent.value = Math.round((index / total) * 100);

      // What the last batch cost decides the next one's size.
      if (took < FRAME_BUDGET_MS / 2) batchSize = Math.min(batchSize * 2, MAX_BATCH_TOKENS);
      else if (took > FRAME_BUDGET_MS) batchSize = Math.max(Math.floor(batchSize / 2), 1);

      // eslint-disable-next-line no-await-in-loop
      if (index < total) await yieldToBrowser();
    }
  } catch (err) {
    console.error('Markdown preview failed:', err);
    error.value = err?.message || 'Unable to render markdown preview.';
  } finally {
    rendering.value = false;
  }
});
</script>
