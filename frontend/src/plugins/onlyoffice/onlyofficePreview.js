import { useFeaturesStore } from '@/stores/features';
import { useSettingsStore } from '@/stores/settings';
import { requestOnlyOfficeForceSave } from '@/api';

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

  // The backend queues and retries this command without holding the preview
  // open. ONLYOFFICE's normal status-2 callback remains the fallback.
  onBeforeClose: (context) => {
    const sessionId = context?.previewState?.forceSaveSessionId;
    if (!context?.filePath || !sessionId) return;
    void requestOnlyOfficeForceSave(context.filePath, { sessionId }).catch(() => {});
  },

  actions: (context) => [
    {
      id: 'download',
      label: 'Download',
      run: () => context.api.download(),
    },
  ],
});
