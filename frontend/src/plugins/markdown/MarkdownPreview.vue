<!-- MarkdownPreview.vue -->
<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <div
      v-if="loading"
      class="flex flex-1 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400"
    >
      Loading markdown…
    </div>
    <div v-else-if="error" class="p-6 text-sm text-red-600 dark:text-red-400">
      {{ error }}
    </div>
    <article
      v-else
      class="prose prose-slate dark:prose-invert mx-auto w-full max-w-3xl flex-1 px-6 py-8"
      v-html="html"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
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

const loading = ref(false);
const html = ref('');
const error = ref('');

/**
 * How much markdown is worth turning into a page.
 *
 * Rendering happens on the one thread the interface has: `marked` walks the
 * whole document, DOMPurify walks the HTML it produced, and the browser then
 * lays out every node of it. A few megabytes of markdown is minutes of that,
 * during which nothing else in the application responds — and the result is a
 * document nobody scrolls through anyway.
 *
 * Refusing to render it is not a limitation to hide: the file opens in the
 * editor, and it downloads, both of which are what someone with a document
 * that size actually wants.
 *
 * Set by the server (`PREVIEW_MAX_RENDER_SIZE`) rather than fixed here. It was
 * fixed here, which meant someone who raised the editor's limit in good faith
 * was refused at a number that appeared in no setting and no document, and had
 * no way to find out where it came from.
 */
const DEFAULT_MAX_PREVIEW_BYTES = 512 * 1024;

const maxPreviewBytes = computed(() =>
  Number.isFinite(featuresStore.previewMaxRenderBytes)
    ? featuresStore.previewMaxRenderBytes
    : DEFAULT_MAX_PREVIEW_BYTES
);

onMounted(async () => {
  loading.value = true;
  error.value = '';

  try {
    // Lazy load marked
    const { marked } = await import('marked');

    // Fetch content
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

    // Parse and sanitize
    const rawHtml = marked.parse(content);
    html.value = DOMPurify.sanitize(rawHtml);
  } catch (err) {
    console.error('Markdown preview failed:', err);
    error.value = err?.message || 'Unable to render markdown preview.';
  } finally {
    loading.value = false;
  }
});
</script>
