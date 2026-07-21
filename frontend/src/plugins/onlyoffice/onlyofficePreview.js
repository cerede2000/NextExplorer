import { useFeaturesStore } from '@/stores/features';
import { useSettingsStore } from '@/stores/settings';
import { closeOnlyOfficeSession, requestOnlyOfficeForceSave } from '@/api';

const CLOSE_REQUEST_GRACE_MS = 450;

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

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

  // Wait only for NextExplorer to accept the request, never for Document
  // Server to assemble and download the document. This makes the request
  // reliable without making the editor visibly wait for a status-6 callback.
  onBeforeClose: async (context) => {
    const sessionId = context?.previewState?.forceSaveSessionId;
    if (!context?.filePath || !sessionId) return;

    const request = context.previewState.requestForceSave
      ? context.previewState.requestForceSave({ reason: 'close' })
      : requestOnlyOfficeForceSave(context.filePath, { sessionId, reason: 'close' });

    await Promise.race([Promise.resolve(request).catch(() => {}), wait(CLOSE_REQUEST_GRACE_MS)]);
    void closeOnlyOfficeSession(context.filePath, { sessionId }).catch(() => {});
  },

  actions: (context) => [
    {
      id: 'download',
      label: 'Download',
      run: () => context.api.download(),
    },
  ],
});
