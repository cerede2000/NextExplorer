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
const FORCE_SAVE_CLOSE_TIMEOUT_MS = 7000;
const CHANGE_FLUSH_TIMEOUT_MS = 1200;
const FORCE_SAVE_RETRY_DELAY_MS = 350;

const wait = (delayMs, signal) =>
  new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });

const waitForEditorChanges = async (previewState, signal) => {
  if (!previewState?.changesPending) return;

  await new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, CHANGE_FLUSH_TIMEOUT_MS);
    previewState.resolveChangesFlushed = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
};

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

  // Wait for the editor to hand its last changes to Document Server before
  // asking it to force-save. The callback still provides a safe fallback when
  // the server cannot complete this accelerated path.
  onBeforeClose: async (context) => {
    if (!context?.filePath) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FORCE_SAVE_CLOSE_TIMEOUT_MS);
    try {
      await waitForEditorChanges(context.previewState, controller.signal);
      let result = await requestOnlyOfficeForceSave(context.filePath, {
        signal: controller.signal,
      });

      // Error 4 means that no change reached Document Server before the
      // command. Retry once while the editor still reports pending changes.
      if (result?.code === 4 && context.previewState?.changesPending && !controller.signal.aborted) {
        await wait(FORCE_SAVE_RETRY_DELAY_MS, controller.signal);
        result = await requestOnlyOfficeForceSave(context.filePath, {
          signal: controller.signal,
        });
      }
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
