<template>
  <!--
    Reading, not opening. Nothing from inside an archive is ever handed to the
    browser as a page: the bytes are fetched as data and drawn here, which is
    what keeps somebody else's HTML from running on this origin.
  -->
  <div class="flex min-h-0 flex-1 flex-col" data-testid="archive-reader">
    <p
      v-if="error"
      class="p-6 text-sm text-neutral-600 dark:text-neutral-400"
      data-testid="archive-reader-error"
    >
      {{ error }}
    </p>

    <p
      v-else-if="loading"
      class="p-6 text-sm text-neutral-500 dark:text-neutral-400"
      data-testid="archive-reader-loading"
    >
      {{ $t('common.loading') }}
    </p>

    <div
      v-else-if="kind === 'image'"
      class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-neutral-100 p-4 dark:bg-zinc-950"
    >
      <img
        :src="imageUrl"
        :alt="entry.name"
        class="max-h-full max-w-full object-contain"
        data-testid="archive-reader-image"
      />
    </div>

    <article
      v-else-if="kind === 'markdown'"
      ref="rendered"
      class="markdown-preview prose prose-slate dark:prose-invert mx-auto w-full max-w-3xl min-h-0 flex-1 overflow-y-auto px-6 py-6"
      data-testid="archive-reader-markdown"
    />

    <pre
      v-else
      class="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap text-neutral-800 dark:text-neutral-200"
      data-testid="archive-reader-text"
      >{{ text }}</pre>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import DOMPurify from 'dompurify';

import { readArchiveEntry } from '@/api';
import { formatBytes } from '@/utils';
import { isEditableExtension } from '@/config/editor';
import { entryKind } from './readable';

const props = defineProps({
  /** The archive on disk, the way every other call names it. */
  filePath: { type: String, required: true },
  /** One row of the listing: `{ name, path, size }`. */
  entry: { type: Object, required: true },
});

const { t } = useI18n();

/**
 * How much of an entry the panel will read.
 *
 * Text is decoded and laid out in one go here — the editor's trick of
 * rendering a document in slabs is worth its complexity for a file someone
 * came to read, not for a look inside an archive — so the ceiling is what a
 * window can draw without holding the tab. An image is decoded by the browser
 * itself and only has to be held once, so it can be larger.
 *
 * Past the ceiling the panel says so and names the size, because the entry is
 * still there to be downloaded or extracted: a refusal that explains itself is
 * the difference between a limit and a defect.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const kind = computed(() => entryKind(props.entry?.name || '', isEditableExtension));
const ceiling = computed(() => (kind.value === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES));

const loading = ref(false);
const error = ref('');
const text = ref('');
const imageUrl = ref('');
const rendered = ref(null);

let reading = null;

/** An object URL is held by the document until it is let go of, image and all. */
const releaseImage = () => {
  if (!imageUrl.value) return;
  URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = '';
};

const tooBig = (size) =>
  t('archive.tooBigToRead', {
    size: formatBytes(size),
    ceiling: formatBytes(ceiling.value),
  });

/**
 * Markdown, sanitised into nodes rather than into a string of HTML.
 *
 * The same pipeline the document preview uses, for the same reason: what comes
 * out of an archive is somebody else's file, and the only markup that reaches
 * the page is markup DOMPurify has already looked at.
 */
const renderMarkdown = async (source) => {
  const { marked } = await import('marked');
  const fragment = DOMPurify.sanitize(marked.parse(source), { RETURN_DOM_FRAGMENT: true });
  await nextTick();
  if (!rendered.value) return;
  rendered.value.replaceChildren(fragment);
};

const read = async () => {
  reading?.abort();
  const mine = new AbortController();
  reading = mine;

  releaseImage();
  text.value = '';
  error.value = '';
  rendered.value?.replaceChildren();

  if (!kind.value) {
    error.value = t('archive.notReadable');
    return;
  }

  // What the listing says it weighs, before a single byte is asked for.
  const announced = Number(props.entry?.size);
  if (Number.isFinite(announced) && announced > ceiling.value) {
    error.value = tooBig(announced);
    return;
  }

  loading.value = true;
  try {
    const response = await readArchiveEntry(props.filePath, props.entry.path, {
      signal: mine.signal,
    });
    if (mine.signal.aborted) return;

    // And what the answer says it weighs, in case the listing was silent.
    const sent = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(sent) && sent > ceiling.value) {
      error.value = tooBig(sent);
      return;
    }

    if (kind.value === 'image') {
      const blob = await response.blob();
      if (mine.signal.aborted) return;
      imageUrl.value = URL.createObjectURL(blob);
    } else {
      const body = await response.text();
      if (mine.signal.aborted) return;
      if (kind.value === 'markdown') {
        loading.value = false;
        await renderMarkdown(body);
      } else {
        text.value = body;
      }
    }
  } catch (failure) {
    if (mine.signal.aborted) return;
    error.value = failure?.message || t('archive.readFailed');
  } finally {
    if (reading === mine) loading.value = false;
  }
};

// Watched as one name rather than as two values: a getter that builds an array
// is a new array every time, which reads the entry again for nothing.
watch(() => `${props.filePath}\u0000${props.entry?.path}`, read, { immediate: true });

onBeforeUnmount(() => {
  reading?.abort();
  releaseImage();
});
</script>
