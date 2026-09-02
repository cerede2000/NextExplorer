import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import MarkdownPreview from './MarkdownPreview.vue';
import { useFeaturesStore } from '@/stores/features';

/**
 * Rendering happens on the one thread the interface has: marked walks the whole
 * document, DOMPurify walks the HTML it produced, and the browser lays out
 * every node. A few megabytes of that is minutes during which nothing else in
 * the application responds — and the result is a page nobody scrolls.
 *
 * The refusal has to explain itself. Someone who raised EDITOR_MAX_FILESIZE to
 * 10 MB and was then refused a 6.5 MB document had no way of knowing that the
 * preview answers to a different setting over different work — the number that
 * stopped them appeared in no setting and no document.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      preview: {
        tooLargeToRenderSized: 'This document is {size}. The preview stops at {limit}.',
        tooLargeToRenderWithEditor:
          'This document is {size}. The preview stops at {limit}; the editor opens up to {editorLimit}.',
      },
    },
  },
});

const mountWith = (content) =>
  mount(MarkdownPreview, {
    props: {
      item: { name: 'notes.md' },
      extension: 'md',
      filePath: 'Docs/notes.md',
      previewUrl: '/preview',
      api: { fetchContent: vi.fn().mockResolvedValue({ content }) },
    },
    global: { plugins: [i18n] },
  });

const settle = async () => {
  // The component imports its renderer on demand; that has to land first.
  await vi.dynamicImportSettled();
  await flushPromises();
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('previewing a markdown document', () => {
  it('renders one of an ordinary size', async () => {
    const wrapper = mountWith('# Title\n\nSome **bold** text.');
    await settle();

    expect(wrapper.html()).toContain('<h1');
    expect(wrapper.text()).not.toContain('preview stops');
  });

  // Six megabytes is what someone reported freezing the whole interface.
  it('refuses one that would freeze the interface', async () => {
    const wrapper = mountWith(`# Title\n\n${'word '.repeat(1500000)}`);
    await settle();

    expect(wrapper.text()).toContain('preview stops');
    expect(wrapper.html()).not.toContain('<h1');
  });

  it('names the document size and the limit that stopped it', async () => {
    const store = useFeaturesStore();
    store.previewMaxRenderBytes = 1024;
    store.editorMaxFileSizeBytes = null;

    const wrapper = mountWith('x'.repeat(4096));
    await settle();

    expect(wrapper.text()).toContain('4 KB');
    expect(wrapper.text()).toContain('1 KB');
  });

  // The whole point: the two limits are different settings over different
  // work, and someone who set one of them is owed that sentence here.
  it('names the editor limit too, so the two are not confused', async () => {
    const store = useFeaturesStore();
    store.previewMaxRenderBytes = 1024;
    store.editorMaxFileSizeBytes = 10 * 1024 * 1024;

    const wrapper = mountWith('x'.repeat(4096));
    await settle();

    expect(wrapper.text()).toContain('editor opens up to 10 MB');
  });

  // The server decides, not the component.
  it('renders what a raised server limit allows', async () => {
    const store = useFeaturesStore();
    store.previewMaxRenderBytes = 8 * 1024 * 1024;

    const wrapper = mountWith(`# Title\n\n${'word '.repeat(300000)}`);
    await settle();

    expect(wrapper.html()).toContain('<h1');
    expect(wrapper.text()).not.toContain('preview stops');
  });
});
