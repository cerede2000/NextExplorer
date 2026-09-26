import { useFeaturesStore } from '@/stores/features';
import { useSettingsStore } from '@/stores/settings';
import { endOnlyOfficeSession } from '@/api';

const DEFAULT_EXTS = [
  'docx',
  'doc',
  'odt',
  'rtf',
  'xlsx',
  'xls',
  'ods',
  'csv',
  'pptx',
  'ppt',
  'odp',
];

export const onlyofficePreviewPlugin = (extensions) => ({
  id: 'onlyoffice-editor',
  label: 'ONLYOFFICE',
  priority: 50,
  // Render with minimal chrome in the overlay host
  minimalHeader: true,
  // Can open an earlier version of a document, to be read (`item.versionId`).
  supportsVersions: true,

  match: (context) => {
    const ext = String(context.extension || '').toLowerCase();
    const list = Array.isArray(extensions) && extensions.length > 0 ? extensions : DEFAULT_EXTS;

    //console.log('ONLYOFFICE checking extension:', ext, list);
    if (!list.includes(ext)) return false;

    const featuresStore = useFeaturesStore();
    const hasBothEditors = Boolean(
      featuresStore.onlyofficeEnabled && featuresStore.collaboraEnabled
    );
    if (!hasBothEditors) return true;

    const settingsStore = useSettingsStore();
    return settingsStore.officeEditorPreference !== 'collabora';
  },

  component: () => import('./OnlyOfficePreview.vue'),

  /**
   * Leaving the document: end the editing session, which flushes what the
   * editor holds on the way.
   *
   * `unloading` is the same closing, from a tab that is going away. There is
   * one synchronous moment and no way to wait between two requests, so the
   * order lives on the server: one beacon to `/session-end`, which flushes and
   * then closes. Either way the server is left holding the same thing — the
   * session gone, a last save queued, and the advisory "being edited" standing
   * until the Document Server says the document was let go.
   */
  onBeforeClose: async (context, { unloading = false } = {}) => {
    const sessionId = context?.previewState?.editorSessionId;
    // The document may have been renamed from the editor's title bar, in which
    // case the context still names the file the preview was opened on.
    const filePath = context?.previewState?.documentPath || context?.filePath;
    if (!filePath || !sessionId) return;

    if (unloading) {
      void endOnlyOfficeSession(filePath, { sessionId, beacon: true });
      return;
    }

    await endOnlyOfficeSession(filePath, { sessionId }).catch(() => {});
  },

  actions: (context) => [
    {
      id: 'download',
      label: 'Download',
      run: () => context.api.download(),
    },
  ],
});
