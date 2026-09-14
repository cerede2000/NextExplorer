import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

/**
 * The heartbeat is what keeps a document marked as being edited: it reports
 * the document open every minute, and the marker outlives the last report by
 * two minutes.
 *
 * So an interval that survives the preview never lets the marker go — the file
 * stays listed as open for as long as the tab lives, and nothing in the editor
 * or the file list can explain why.
 */

const fetchOnlyOfficeConfig = vi.fn();
const heartbeatOnlyOfficeSession = vi.fn();
const fetchOnlyOfficeHistory = vi.fn();
const fetchOnlyOfficeHistoryData = vi.fn();
const restoreVersion = vi.fn();
const features = { versionsEnabled: true };
const panel = vi.hoisted(() => ({ store: null }));

vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));
vi.mock('@/stores/versionsPanel', async () => {
  const { reactive } = await import('vue');
  panel.store = reactive({ restored: 0, relativePath: '', markRestored: () => {} });
  return { useVersionsPanelStore: () => panel.store };
});

vi.mock('@/api', () => ({
  fetchOnlyOfficeHistory: (...args) => fetchOnlyOfficeHistory(...args),
  fetchOnlyOfficeHistoryData: (...args) => fetchOnlyOfficeHistoryData(...args),
  restoreVersion: (...args) => restoreVersion(...args),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  fetchOnlyOfficeConfig: (...args) => fetchOnlyOfficeConfig(...args),
  fetchOnlyOfficeMentionUsers: vi.fn(),
  fetchOnlyOfficeStorageFile: vi.fn(),
  heartbeatOnlyOfficeSession: (...args) => heartbeatOnlyOfficeSession(...args),
  notifyOnlyOfficeMention: vi.fn(),
  requestOnlyOfficeForceSave: vi.fn(() => Promise.resolve({ queued: true })),
  renameOnlyOfficeDocument: vi.fn(),
  saveOnlyOfficeDocumentAs: vi.fn(),
  browse: vi.fn(() => Promise.resolve({ items: [], path: '' })),
}));

vi.mock('@/stores/fileStore', () => ({
  useFileStore: () => ({ currentPath: '', fetchPathItems: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: vi.fn() }),
}));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => ({ isDark: false }) }));
vi.mock('@/plugins/preview/manager', () => ({
  usePreviewManager: () => ({ close: vi.fn() }),
}));

let capturedConfig = null;
vi.mock('@onlyoffice/document-editor-vue', () => ({
  DocumentEditor: defineComponent({
    props: { config: { type: Object, default: null } },
    setup(props) {
      capturedConfig = props.config;
      return () => h('div');
    },
  }),
}));

import OnlyOfficePreview from './OnlyOfficePreview.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } });

const configResponse = (sessionId) => ({
  documentServerUrl: 'https://ds.example.com',
  config: { document: { key: 'k' }, editorConfig: {} },
  forceSaveSessionId: sessionId,
  autoSaveIntervalMs: 0,
});

const mountPreview = () =>
  mount(OnlyOfficePreview, {
    props: {
      item: { name: 'report.docx', path: '' },
      extension: 'docx',
      filePath: 'report.docx',
      previewUrl: '',
      previewState: {},
      api: {},
    },
    global: {
      plugins: [i18n],
      stubs: { ShareDialog: true, StoragePickerDialog: true },
    },
  });

beforeEach(() => {
  vi.useFakeTimers();
  capturedConfig = null;
  fetchOnlyOfficeConfig.mockReset();
  heartbeatOnlyOfficeSession.mockReset();
  heartbeatOnlyOfficeSession.mockResolvedValue({ active: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The history the editor shows is NextExplorer's versions: the editor asks for
 * the list, then for each version as it is clicked, and restoring goes through
 * the versions like a restore from the panel.
 */
describe('the document history in the editor', () => {
  const HISTORY = {
    currentVersion: 2,
    history: [
      {
        version: 1,
        versionId: 'v-older-0000000001',
        key: 'version-v-older-0000000001',
        created: '2026-09-14T09:00:00.000Z',
        user: { id: 'u1', name: 'Alice' },
      },
      {
        version: 2,
        versionId: null,
        key: 'k',
        created: '2026-09-14T10:00:00.000Z',
        user: { id: 'u1', name: 'Alice' },
      },
    ],
    canRestore: true,
  };

  const editable = (sessionId = 'session-1') => ({
    ...configResponse(sessionId),
    config: { document: { key: 'k', permissions: { edit: true } }, editorConfig: {} },
  });

  let editor;

  let mounted = [];

  const mountOn = (item = { name: 'report.docx', path: '' }) => {
    const wrapper = mount(OnlyOfficePreview, {
      props: {
        item,
        extension: 'docx',
        filePath: 'report.docx',
        previewUrl: '',
        previewState: {},
        api: {},
      },
      global: { plugins: [i18n], stubs: { ShareDialog: true, StoragePickerDialog: true } },
    });
    mounted.push(wrapper);
    return wrapper;
  };

  beforeEach(() => {
    features.versionsEnabled = true;
    fetchOnlyOfficeHistory.mockReset();
    fetchOnlyOfficeHistoryData.mockReset();
    restoreVersion.mockReset();
    editor = { refreshHistory: vi.fn(), setHistoryData: vi.fn(), refreshFile: vi.fn() };
    window.DocEditor = { instances: { 'onlyoffice-report-docx': editor } };
    if (panel.store) Object.assign(panel.store, { restored: 0, relativePath: '' });
  });

  // A preview left mounted — by a test that failed before unmounting it — keeps
  // watching the Versions panel, and answers the next test's restores too.
  afterEach(() => {
    for (const wrapper of mounted) {
      try {
        wrapper.unmount();
      } catch {
        // Already unmounted by the test itself.
      }
    }
    mounted = [];
  });

  it('is offered where versions are kept, and not where they are not', async () => {
    // A configuration of its own for each opening, as the server sends: the
    // preview adds its events to the one it is given.
    fetchOnlyOfficeConfig.mockImplementation(async () => editable());
    mountOn();
    await flushPromises();
    expect(typeof capturedConfig.events.onRequestHistory).toBe('function');

    features.versionsEnabled = false;
    mountOn();
    await flushPromises();
    expect(capturedConfig.events.onRequestHistory).toBeUndefined();
    expect(capturedConfig.events.onRequestRestore).toBeUndefined();
  });

  it("lists NextExplorer's versions as the editor's history, the current state last", async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    fetchOnlyOfficeHistory.mockResolvedValue(HISTORY);
    const wrapper = mountOn();
    await flushPromises();

    capturedConfig.events.onRequestHistory();
    await flushPromises();

    expect(fetchOnlyOfficeHistory).toHaveBeenCalledWith('report.docx');
    const shown = editor.refreshHistory.mock.calls.at(-1)[0];
    expect(shown.currentVersion).toBe(2);
    expect(shown.history.map((entry) => [entry.version, entry.key, entry.user.name])).toEqual([
      [1, 'version-v-older-0000000001', 'Alice'],
      [2, 'k', 'Alice'],
    ]);
    expect(typeof shown.history[0].created).toBe('string');
    wrapper.unmount();
  });

  it('asks for the version clicked by its id, and for the current state without one', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    fetchOnlyOfficeHistory.mockResolvedValue(HISTORY);
    fetchOnlyOfficeHistoryData.mockResolvedValue({ version: 1, url: 'https://x', token: 't' });
    const wrapper = mountOn();
    await flushPromises();
    capturedConfig.events.onRequestHistory();
    await flushPromises();

    capturedConfig.events.onRequestHistoryData({ data: 1 });
    await flushPromises();
    expect(fetchOnlyOfficeHistoryData).toHaveBeenLastCalledWith('report.docx', {
      version: 1,
      versionId: 'v-older-0000000001',
    });
    expect(editor.setHistoryData).toHaveBeenLastCalledWith({
      version: 1,
      url: 'https://x',
      token: 't',
    });

    capturedConfig.events.onRequestHistoryData({ data: 2 });
    await flushPromises();
    expect(fetchOnlyOfficeHistoryData).toHaveBeenLastCalledWith('report.docx', {
      version: 2,
      versionId: undefined,
    });
    wrapper.unmount();
  });

  it('tells the editor why the history or a version would not come', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    fetchOnlyOfficeHistory.mockRejectedValue(new Error('The history of this file is not shared.'));
    fetchOnlyOfficeHistoryData.mockRejectedValue(new Error('This version does not exist.'));
    const wrapper = mountOn();
    await flushPromises();

    capturedConfig.events.onRequestHistory();
    capturedConfig.events.onRequestHistoryData({ data: 1 });
    await flushPromises();

    expect(editor.refreshHistory).toHaveBeenCalledWith({
      error: 'The history of this file is not shared.',
    });
    expect(editor.setHistoryData).toHaveBeenCalledWith({
      version: 1,
      error: 'This version does not exist.',
    });
    wrapper.unmount();
  });

  it('restores through the versions, then opens the document again', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    fetchOnlyOfficeHistory.mockResolvedValue(HISTORY);
    restoreVersion.mockResolvedValue({ status: 'saved' });
    const wrapper = mountOn();
    await flushPromises();
    capturedConfig.events.onRequestHistory();
    await flushPromises();
    fetchOnlyOfficeConfig.mockClear();

    capturedConfig.events.onRequestRestore({ data: { version: 1 } });
    await flushPromises();

    expect(restoreVersion).toHaveBeenCalledWith('report.docx', 'v-older-0000000001');
    expect(fetchOnlyOfficeConfig).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('restores nothing for the current state, which already is the document', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    fetchOnlyOfficeHistory.mockResolvedValue(HISTORY);
    const wrapper = mountOn();
    await flushPromises();
    capturedConfig.events.onRequestHistory();
    await flushPromises();

    capturedConfig.events.onRequestRestore({ data: { version: 2 } });
    await flushPromises();

    expect(restoreVersion).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('offers no restore to someone who may not change the document', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(configResponse(null));
    const wrapper = mountOn();
    await flushPromises();

    expect(typeof capturedConfig.events.onRequestHistory).toBe('function');
    expect(capturedConfig.events.onRequestRestore).toBeUndefined();
    wrapper.unmount();
  });

  it('opens an earlier version to be read, with no history of its own', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(configResponse(null));
    const wrapper = mountOn({ name: 'report.docx', path: '', versionId: 'v-older-0000000001' });
    await flushPromises();

    expect(fetchOnlyOfficeConfig).toHaveBeenCalledWith('report.docx', 'view', {
      theme: 'light',
      versionId: 'v-older-0000000001',
    });
    expect(capturedConfig.events.onRequestHistory).toBeUndefined();
    wrapper.unmount();
  });

  it('points the editor at the document once the Versions panel restored it', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(editable());
    const wrapper = mountOn();
    await flushPromises();
    fetchOnlyOfficeConfig.mockClear();

    panel.store.relativePath = 'other.docx';
    panel.store.restored += 1;
    await flushPromises();
    expect(fetchOnlyOfficeConfig).not.toHaveBeenCalled();

    panel.store.relativePath = 'report.docx';
    panel.store.restored += 1;
    await flushPromises();
    expect(fetchOnlyOfficeConfig).toHaveBeenCalledTimes(1);
    expect(editor.refreshFile).toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('OnlyOffice preview presence', () => {
  it('stops reporting the document open once the preview is gone', async () => {
    fetchOnlyOfficeConfig.mockResolvedValue(configResponse('session-1'));

    const wrapper = mountPreview();
    await flushPromises();

    capturedConfig.events.onDocumentReady();
    await flushPromises();
    expect(heartbeatOnlyOfficeSession).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    heartbeatOnlyOfficeSession.mockClear();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(heartbeatOnlyOfficeSession).not.toHaveBeenCalled();
  });

  it('does not revive the heartbeat with a refresh that outlived the preview', async () => {
    // The editor reports an outdated document as it saves on the way out, so
    // this refresh is in flight exactly when the preview is being closed.
    let resolveRefresh;
    fetchOnlyOfficeConfig.mockResolvedValueOnce(configResponse('session-1')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(configResponse('session-2'));
        })
    );

    // The refresh hands the new document to the running editor, so the editor
    // has to be there: without it the code takes its fallback path and never
    // reaches the heartbeat this test is about.
    const refreshFile = vi.fn();
    window.DocEditor = { instances: { 'onlyoffice-report-docx': { refreshFile } } };

    const wrapper = mountPreview();
    await flushPromises();

    capturedConfig.events.onDocumentReady();
    await flushPromises();

    capturedConfig.events.onOutdatedVersion();
    wrapper.unmount();
    heartbeatOnlyOfficeSession.mockClear();

    resolveRefresh();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(heartbeatOnlyOfficeSession).not.toHaveBeenCalled();
  });
});
