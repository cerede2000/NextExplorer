<!-- MarkdownPreview.vue -->
<template>
  <div class="relative flex h-full flex-col">
    <div
      v-if="error"
      class="p-6 text-sm text-red-600 dark:text-red-400"
      data-testid="markdown-preview-error"
    >
      {{ error }}
    </div>
    <template v-else>
      <!--
        Outside the scrolling container on purpose. Sticky inside one means the
        browser reworks its position every time the content grows, and the
        content grows a few hundred times while a large document is read.
      -->
      <div
        v-if="rendering"
        class="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white/90 px-6 py-2 text-xs text-neutral-500 backdrop-blur dark:border-neutral-800 dark:bg-zinc-900/90 dark:text-neutral-400"
        data-testid="markdown-preview-progress"
      >
        <span
          class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        {{ $t('preview.stillRendering', { percent: renderedPercent }) }}
      </div>
      <div class="flex-1 overflow-y-auto">
        <article
          ref="container"
          class="markdown-preview prose prose-slate dark:prose-invert mx-auto w-full max-w-3xl px-6 py-8"
        />
      </div>
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
 * - **The document is read in slabs, not read whole and then rendered in
 *   pieces.** Measured on seventeen megabytes: lexing it in one call is
 *   1396 ms of frozen tab and produces 384,000 tokens, while rendering all of
 *   those tokens is 236 ms. The expensive half was the half that ran first and
 *   whole. Cut at blank lines — never inside a fenced code block — into slabs
 *   of about sixty-four kilobytes, the same total work has a worst slab of
 *   18 ms. Each slab is lexed, rendered and appended before the next is
 *   looked at, and the batch adapts to what the last one cost.
 * - **Sanitising straight into a fragment.** `RETURN_DOM_FRAGMENT` removes an
 *   entire parse of a multi-megabyte string, and the string with it.
 * - **`content-visibility: auto` per chunk.** The browser skips layout and
 *   paint for chunks that are off screen, which is what keeps scrolling smooth
 *   once the whole document exists. Unlike hiding them, the text stays
 *   findable: Ctrl+F still crosses the whole document, which is the reason
 *   this is not virtualised.
 * - **One yield per frame's worth of work, not one per slab.** Handing the
 *   browser back costs a frame whether five milliseconds went into the slab or
 *   twelve, so a yield after each of two hundred and seventy-eight slabs is
 *   four and a half seconds of waiting that no amount of faster rendering
 *   removes. Slabs are rendered until the budget is spent, and the frame is
 *   given back once.
 */
const FRAME_BUDGET_MS = 12;
const INITIAL_SLAB_BYTES = 64 * 1024;
const MIN_SLAB_BYTES = 8 * 1024;
const MAX_SLAB_BYTES = 512 * 1024;

/**
 * Where the next slab may end: a blank line, at or past the target, and never
 * inside a fenced code block — splitting one would leave the fence unclosed
 * and the rest of the document rendered as code.
 *
 * Written over the source string rather than over `split('\n')`, which would
 * hold the whole document a second time in several hundred thousand pieces.
 */
const nextSlabEnd = (text, from, target) => {
  let index = from;
  let fence = null;

  while (index < text.length) {
    let lineEnd = text.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = text.length;

    let firstNonSpace = index;
    while (firstNonSpace < lineEnd && (text[firstNonSpace] === ' ' || text[firstNonSpace] === '\t')) {
      firstNonSpace += 1;
    }
    const blank = firstNonSpace === lineEnd;
    const opener = text[firstNonSpace];

    if (!blank && (opener === '`' || opener === '~')) {
      const marker = /^(`{3,}|~{3,})/.exec(text.slice(firstNonSpace, lineEnd));
      if (marker) fence = fence && marker[1].startsWith(fence[0]) ? null : fence || marker[1];
    }

    index = lineEnd + 1;
    if (!fence && blank && index - from >= target) return Math.min(index, text.length);
  }

  return text.length;
};

/**
 * Reference-style link definitions, gathered before anything is rendered.
 *
 * The lexer collects them onto the token array it produces, so a document read
 * in slabs would only know the ones defined earlier — and `[text][ref]` whose
 * definition sits at the bottom would render as literal brackets. The scan
 * only happens for a document that contains `]:` at all, which most do not.
 */
const LINK_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["'(]([^"')]*)["')])?\s*$/gm;

const collectLinkDefinitions = (text) => {
  if (!text.includes(']:')) return '';

  LINK_DEFINITION.lastIndex = 0;
  const found = text.match(LINK_DEFINITION);
  return found ? `${found.join('\n')}\n\n` : '';
};

const yieldToBrowser = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

let cancelled = false;
onBeforeUnmount(() => {
  cancelled = true;
});

/**
 * One chunk of rendered markdown, and the hints that let it be skipped.
 *
 * The placeholder height is estimated from the source it came from rather than
 * fixed, because slabs grow as the document is read and a constant would have
 * a half-megabyte chunk and a sixty-four kilobyte one claim the same space —
 * the scrollbar then lurches every time one of them is measured for real.
 * Roughly ninety characters to a line and twenty-four pixels to a line is
 * crude, and still an order of magnitude closer than one number for all.
 */
const CHARACTERS_PER_LINE = 90;
const PIXELS_PER_LINE = 24;

const appendChunk = (fragment, sourceLength) => {
  const section = document.createElement('section');
  const estimate = Math.max(200, Math.round((sourceLength / CHARACTERS_PER_LINE) * PIXELS_PER_LINE));
  section.style.contentVisibility = 'auto';
  // `auto` first: once a chunk has been on screen the browser remembers what
  // it really measured and stops using the estimate at all.
  section.style.containIntrinsicSize = `auto ${estimate}px`;
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

    const links = collectLinkDefinitions(content);
    const total = content.length;
    let index = 0;
    let slabBytes = INITIAL_SLAB_BYTES;

    let sliceStartedAt = Date.now();

    while (index < total) {
      if (cancelled) return;

      const end = nextSlabEnd(content, index, slabBytes);
      const slab = content.slice(index, end);

      const startedAt = Date.now();
      // Prepended rather than assigned afterwards: the lexer resolves inline
      // tokens as it goes, so `[text][ref]` is already literal text by the
      // time it returns. Definitions produce no output of their own, so
      // carrying them into every slab shows nothing and costs a few lines.
      const tokens = marked.lexer(links + slab);

      const fragment = DOMPurify.sanitize(marked.parser(tokens), {
        RETURN_DOM_FRAGMENT: true,
      });
      if (cancelled) return;
      appendChunk(fragment, slab.length);
      const took = Date.now() - startedAt;

      index = end;

      // What the last slab cost decides the next one's size.
      if (took < FRAME_BUDGET_MS / 2) slabBytes = Math.min(slabBytes * 2, MAX_SLAB_BYTES);
      else if (took > FRAME_BUDGET_MS) slabBytes = Math.max(Math.floor(slabBytes / 2), MIN_SLAB_BYTES);

      if (index < total && Date.now() - sliceStartedAt >= FRAME_BUDGET_MS) {
        // The percentage is written here rather than after every slab: it is a
        // reactive value on a sticky element inside the scrolling container,
        // and asking for it to be redrawn while the container is growing is
        // asking the browser to lay the whole thing out again.
        renderedPercent.value = Math.round((index / total) * 100);
        // eslint-disable-next-line no-await-in-loop
        await yieldToBrowser();
        sliceStartedAt = Date.now();
      }
    }

    renderedPercent.value = 100;
  } catch (err) {
    console.error('Markdown preview failed:', err);
    error.value = err?.message || 'Unable to render markdown preview.';
  } finally {
    rendering.value = false;
  }
});
</script>
