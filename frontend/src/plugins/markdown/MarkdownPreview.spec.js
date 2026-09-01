import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

import MarkdownPreview from './MarkdownPreview.vue';

/**
 * Rendering happens on the one thread the interface has: marked walks the whole
 * document, DOMPurify walks the HTML it produced, and the browser lays out
 * every node. A few megabytes of that is minutes during which nothing else in
 * the application responds — and the result is a page nobody scrolls.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      preview: { tooLargeToRender: 'This document is too large to preview.' },
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

describe('previewing a markdown document', () => {
  it('renders one of an ordinary size', async () => {
    const wrapper = mountWith('# Title\n\nSome **bold** text.');
    // The component imports its renderer on demand; that has to land first.
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.html()).toContain('<h1');
    expect(wrapper.text()).not.toContain('too large');
  });

  // Six megabytes is what someone reported freezing the whole interface.
  it('refuses one that would freeze the interface, and says why', async () => {
    const wrapper = mountWith(`# Title\n\n${'word '.repeat(1500000)}`);
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.text()).toContain('too large to preview');
    expect(wrapper.html()).not.toContain('<h1');
  });
});
