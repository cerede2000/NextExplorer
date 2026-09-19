import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

/**
 * Coming back from the version history, and every other reason the editor is
 * built again over the same document.
 *
 * The editor is not a component that redraws: it is an iframe the Document
 * Server's own script attaches to an element, and it registers itself in
 * `window.DocEditor.instances` under the element's id. That registry is the
 * part that matters here, because the script refuses to attach twice:
 *
 *     if (window.DocEditor.instances[id]) return;   // "Skip loading"
 *
 * So a rebuild that reuses the id depends on the previous instance having
 * been taken out of the registry first — and if anything stops that, the new
 * element stays empty with nothing on screen to say why. The spec beside this
 * one stubs the editor as a plain `<div>`, which cannot show any of this.
 *
 * The stub below is the library's real contract instead: asynchronous attach,
 * the registry, the guard, and `destroyEditor` on the way out.
 */

const fetchOnlyOfficeConfig = vi.fn();
const heartbeatOnlyOfficeSession = vi.fn();
const fetchOnlyOfficeHistory = vi.fn();
const fetchOnlyOfficeHistoryData = vi.fn();
const features = { versionsEnabled: true };

vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/versionsPanel', async () => {
  const { reactive: r } = await import('vue');
  const store = r({ restored: 0, relativePath: '', markRestored: () => {} });
  return { useVersionsPanelStore: () => store };
});
vi.mock('@/api', () => ({
  fetchOnlyOfficeConfig: (...args) => fetchOnlyOfficeConfig(...args),
  fetchOnlyOfficeHistory: (...args) => fetchOnlyOfficeHistory(...args),
  fetchOnlyOfficeHistoryData: (...args) => fetchOnlyOfficeHistoryData(...args),
  heartbeatOnlyOfficeSession: (...args) => heartbeatOnlyOfficeSession(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  restoreVersion: vi.fn(),
  requestOnlyOfficeForceSave: vi.fn(),
  endOnlyOfficeSession: vi.fn(),
  renameOnlyOfficeDocument: vi.fn(),
  saveOnlyOfficeDocumentAs: vi.fn(),
  fetchOnlyOfficeStorageFile: vi.fn(),
  fetchOnlyOfficeMentionUsers: vi.fn(),
  notifyOnlyOfficeMention: vi.fn(),
  browse: vi.fn(() => Promise.resolve({ items: [], path: '' })),
}));
vi.mock('@/stores/fileStore', () => ({
  useFileStore: () => ({ currentPath: 'Docs', fetchPathItems: vi.fn() }),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: vi.fn() }),
}));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => ({ isDark: false }) }));
vi.mock('@/plugins/preview/manager', () => ({ usePreviewManager: () => ({ close: vi.fn() }) }));
vi.mock('@/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every element the stub has ever attached to, in order. */
let attached = [];
/** Ids it refused to attach to because the registry still held one. */
let refused = [];
/** Make `destroyEditor` throw, as a Document Server mid-transition can. */
let destroyThrows = false;

vi.mock('@onlyoffice/document-editor-vue', () => ({
  DocumentEditor: defineComponent({
    name: 'DocumentEditor',
    props: {
      id: { type: String, default: '' },
      config: { type: Object, default: null },
      documentServerUrl: { type: String, default: '' },
    },
    mounted() {
      // `loadScript(...).then(() => this.onLoad())`: never synchronous, even
      // when the script is already in the page.
      const id = this.id;
      const config = this.config;
      void Promise.resolve().then(() => {
        if (window.DocEditor?.instances?.[id]) {
          refused.push(id);
          return;
        }
        if (!window.DocEditor?.instances) window.DocEditor = { instances: {} };
        window.DocEditor.instances[id] = {
          destroyEditor: () => {
            if (destroyThrows) throw new Error('the editor was busy');
          },
          refreshHistory: vi.fn(),
          setHistoryData: vi.fn(),
        };
        attached.push(id);
        config?.events?.onDocumentReady?.();
      });
    },
    unmounted() {
      const id = this.id;
      if (window.DocEditor?.instances?.[id]) {
        window.DocEditor.instances[id].destroyEditor();
        window.DocEditor.instances[id] = undefined;
      }
    },
    render() {
      return h('div');
    },
  }),
}));

let capturedConfig = null;
vi.mock('@/components/ShareDialog.vue', () => ({ default: { render: () => null } }));

import OnlyOfficePreview from './OnlyOfficePreview.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } });

const configResponse = () => ({
  documentServerUrl: 'https://ds.example.com',
  config: { document: { key: 'k', permissions: { edit: true } }, editorConfig: {} },
  forceSaveSessionId: 'session-1',
  autoSaveIntervalMs: 0,
});

let wrapper = null;
let previewState = null;
/** What Vue was told about, rather than what it threw at the test runner. */
let reported = [];

const open = async () => {
  previewState = reactive({});
  wrapper = mount(OnlyOfficePreview, {
    props: {
      item: { name: 'report.docx', path: 'Docs' },
      extension: 'docx',
      filePath: 'Docs/report.docx',
      previewUrl: '',
      previewState,
      api: {},
    },
    global: {
      plugins: [i18n],
      stubs: { ShareDialog: true, StoragePickerDialog: true },
      // A lifecycle hook that throws is reported and the render carries on —
      // which is what the built application does. Without a handler the
      // development build rethrows into the runner instead, and the test
      // would be measuring that rather than the editor.
      config: { errorHandler: (error) => reported.push(error) },
    },
  });
  await flushPromises();
  capturedConfig = wrapper.findComponent({ name: 'DocumentEditor' }).props('config');
  return wrapper;
};

beforeEach(() => {
  attached = [];
  refused = [];
  reported = [];
  destroyThrows = false;
  window.DocEditor = { instances: {} };
  capturedConfig = null;
  fetchOnlyOfficeConfig.mockReset().mockResolvedValue(configResponse());
  heartbeatOnlyOfficeSession.mockReset().mockResolvedValue({ active: true });
  fetchOnlyOfficeHistory.mockReset().mockResolvedValue({ currentVersion: 1, history: [] });
});

afterEach(() => {
  try {
    wrapper?.unmount();
  } catch {
    // already gone
  }
  wrapper = null;
});

describe('leaving the version history', () => {
  it('opens the document again, with an editor that actually attaches', async () => {
    await open();
    expect(attached).toHaveLength(1);
    // The editor has drawn its own chrome, so the floating way out stands down.
    expect(previewState.hasNativeClose).toBe(true);

    capturedConfig.events.onRequestHistory();
    await flushPromises();
    capturedConfig.events.onRequestHistoryClose();
    await flushPromises();

    // The whole of the bug: a second element, and nothing in it.
    expect(refused).toEqual([]);
    expect(attached).toHaveLength(2);
    expect(previewState.hasNativeClose).toBe(true);
  });

  it('opens it again even when the editor refuses to be destroyed', async () => {
    // `destroyEditor` throwing leaves the registry holding the old instance,
    // and every rebuild after that attaches to nothing. Whatever the reason
    // the editor could not be torn down, the way back has to survive it.
    await open();
    destroyThrows = true;

    capturedConfig.events.onRequestHistoryClose();
    await flushPromises();

    expect(reported.map((error) => error.message)).toEqual(['the editor was busy']);
    expect(refused).toEqual([]);
    expect(attached).toHaveLength(2);
    expect(previewState.hasNativeClose).toBe(true);
  });
});
