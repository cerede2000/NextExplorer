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
const FORCE_SAVE_CLOSE_TIMEOUT_MS = 1500;

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

  // Ask Document Server to flush its current version before the iframe is
  // unmounted. Its normal close callback remains in place as a fallback.
  onBeforeClose: async (context) => {
    if (!context?.filePath) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FORCE_SAVE_CLOSE_TIMEOUT_MS);
    try {
      await requestOnlyOfficeForceSave(context.filePath, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  },

  actions: (context) => [
    {
      id: 'download',
      label: 'Download',
      run: () => context.api.download(),
    },
  ],
});
