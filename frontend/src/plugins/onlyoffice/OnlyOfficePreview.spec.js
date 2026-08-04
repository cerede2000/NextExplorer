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

vi.mock('@/api', () => ({
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
