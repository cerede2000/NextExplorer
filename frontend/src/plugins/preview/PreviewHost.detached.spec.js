import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, onMounted, ref, nextTick } from 'vue';

/**
 * Two documents whose viewers take their own elements out of the page.
 *
 * ONLYOFFICE does this: the Document Server's script is handed an element and
 * replaces it with an `iframe`, so the node Vue believes it owns is no longer in
 * the document. With one document on screen at a time this never showed —
 * everything around it was built and thrown away in one piece. With a surface per
 * tab, the host re-renders whenever another tab comes forward, and Vue walked into
 * a subtree whose elements had been taken away: "Cannot set properties of null".
 *
 * So the elements a plugin is given are never patched by anything above them
 * again: each surface is drawn once, and what changes around it — which one is in
 * front — changes nothing inside it.
 */

vi.mock('@/api', () => ({
  getPreviewUrl: (p) => `https://files.example.com/preview?path=${p}`,
  downloadItems: vi.fn(),
  fetchFileContent: vi.fn(),
  fetchMediaTracks: vi.fn(),
  getSubtitleUrl: vi.fn(),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => ({ getCurrentPathItems: [] }) }));
vi.mock('@/router', () => ({ default: { push: vi.fn() } }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

import PreviewHost from './PreviewHost.vue';
import { usePreviewManager } from './manager';
import { useTabsStore } from '@/stores/tabs';

/** A viewer that replaces the element it was given, as DocsAPI does. */
const DetachingViewer = defineComponent({
  name: 'DetachingViewer',
  props: {
    item: { type: Object, required: true },
    extension: { type: String, default: '' },
    filePath: { type: String, default: '' },
    previewUrl: { type: String, default: '' },
    previewState: { type: Object, default: () => ({}) },
    api: { type: Object, default: () => ({}) },
  },
  setup(props) {
    const { previewState } = props;
    const host = ref(null);
    onMounted(() => {
      const element = host.value;
      const frame = document.createElement('iframe');
      frame.dataset.document = props.filePath;
      element?.replaceWith(frame);
      // As the editor does once the document is ready: its own close button is
      // drawn, and the page's fallback one is taken away — a change the surface
      // around it reacts to while the element underneath is already gone. Written
      // on the object rather than through the prop, which is what the plugins do:
      // `previewState` belongs to the preview manager and is handed over to be
      // written on.
      Object.assign(previewState, { hasNativeClose: true });
    });
    return () => h('div', { ref: host }, 'the editor');
  },
});

const officePlugin = {
  id: 'office',
  minimalHeader: true,
  match: () => true,
  component: () => Promise.resolve({ default: DetachingViewer }),
};

const REPORT = { name: 'report.docx', path: 'Docs', kind: 'docx' };
const SHEET = { name: 'budget.xlsx', path: 'Docs', kind: 'xlsx' };

let wrapper = null;
let errors = [];

/** Two tabs, a document open in each, and the host drawing both. */
const twoDocuments = async () => {
  const tabs = useTabsStore();
  tabs.setEnabled(true);
  const manager = usePreviewManager();
  manager.register(officePlugin);
  const first = tabs.activeId;
  const second = tabs.open('/browse/Media').id;

  wrapper = mount(PreviewHost, {
    global: {
      mocks: { $t: (key) => key },
      config: { errorHandler: (error) => errors.push(error?.message || String(error)) },
    },
  });
  manager.openIn(first, REPORT);
  manager.openIn(second, SHEET);
  await flushPromises();
  await nextTick();
  return { tabs, manager, first, second };
};

beforeEach(() => {
  setActivePinia(createPinia());
  errors = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('viewers that take their own element out of the page', () => {
  /**
   * One is enough, which says where this came from: the arrangement is older
   * than these tabs — it was the preview host's, when there was one document at a
   * time — and it fails the moment a viewer replaces its element. What tabs
   * changed is how often anyone meets it: two editors alive at once, each
   * redrawing while the other is on screen.
   */
  it('draws one alone, without the patch losing its place', async () => {
    const tabs = useTabsStore();
    const manager = usePreviewManager();
    manager.register(officePlugin);
    wrapper = mount(PreviewHost, {
      global: {
        mocks: { $t: (key) => key },
        config: { errorHandler: (error) => errors.push(error?.message || String(error)) },
      },
    });
    manager.openIn(tabs.activeId, REPORT);
    await flushPromises();
    await nextTick();

    expect(errors).toEqual([]);
    expect(document.body.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('both draw, each in its own tab', () => {
    return twoDocuments().then(() => {
      expect(document.body.querySelectorAll('iframe')).toHaveLength(2);
      expect(errors).toEqual([]);
    });
  });

  it('survive another tab coming forward, and going back', async () => {
    const { tabs, first, second } = await twoDocuments();

    tabs.activate(second);
    await nextTick();
    tabs.activate(first);
    await nextTick();

    expect(errors).toEqual([]);
    // Still the same two frames: nothing was rebuilt, and nothing was lost.
    expect(document.body.querySelectorAll('iframe')).toHaveLength(2);
  });

  it('survive one of them being closed', async () => {
    const { manager, first, second } = await twoDocuments();

    await manager.closeIn(second);
    await nextTick();

    expect(errors).toEqual([]);
    expect(manager.shows(first, REPORT)).toBe(true);
  });

  it('survive their tab being closed', async () => {
    const { tabs, second } = await twoDocuments();

    tabs.close(second);
    await nextTick();
    await flushPromises();

    expect(errors).toEqual([]);
  });
});
