import { usePreviewManager } from '@/plugins/preview/manager';
import { imagePreviewPlugin } from '@/plugins/image/imagePreview';
import { videoPreviewPlugin } from '@/plugins/video/videoPreview';
import { audioPreviewPlugin } from '@/plugins/audio/audioPreview';
import { markdownPreviewPlugin } from '@/plugins/markdown/markdownPreview';
import { pdfPreviewPlugin } from '@/plugins/pdf/pdfPreview';
import { onlyofficePreviewPlugin } from '@/plugins/onlyoffice/onlyofficePreview';
import { collaboraPreviewPlugin } from '@/plugins/collabora/collaboraPreview';
import { useFeaturesStore } from '@/stores/features';

/**
 * When every plugin that is going to register itself has done so.
 *
 * The editors register asynchronously, once the server has said whether they
 * are configured — which is right for the folder listing, where nothing waits
 * on them, and wrong for a page that opens one document and has to decide
 * whether anything can open it. Asking too early there would answer "nothing
 * here opens this" about a document ONLYOFFICE was a moment from claiming.
 */
let pluginsReady = Promise.resolve();

export const whenPreviewPluginsReady = () => pluginsReady;

/**
 * @param {import('pinia').Pinia} pinia - Pinia instance
 * @param {Object} options - Installation options
 * @param {Array} options.plugins - Additional custom plugins to register
 * @param {boolean} options.skipOnlyOffice - Skip ONLYOFFICE plugin loading
 */
export const installPreviewPlugins = (pinia, options = {}) => {
  const { plugins: customPlugins = [], skipOnlyOffice = false } = options;
  const manager = usePreviewManager(pinia);

  // Register core plugins (synchronous - blocks app startup)
  registerCorePlugins(manager);

  if (customPlugins.length > 0) {
    customPlugins.forEach((plugin) => {
      try {
        manager.register(plugin);
      } catch (error) {
        console.error('Failed to register custom plugin:', error);
      }
    });
  }

  // Load the editors asynchronously (doesn't block startup). Both settle
  // rather than reject — each one already swallows its own failure — so
  // whatever happens, `whenPreviewPluginsReady` resolves.
  pluginsReady = Promise.all([
    skipOnlyOffice ? Promise.resolve() : loadOnlyOfficePlugin(manager),
    loadCollaboraPlugin(manager),
  ]).then(() => undefined);
};

/**
 * Register core preview plugins
 * These are bundled and always available
 */
function registerCorePlugins(manager) {
  const plugins = [
    imagePreviewPlugin(),
    videoPreviewPlugin(),
    audioPreviewPlugin(),
    pdfPreviewPlugin(),
    markdownPreviewPlugin(),
  ];

  plugins.forEach((plugin) => manager.register(plugin));
}

/**
 * Load ONLYOFFICE plugin conditionally based on server features
 * Runs async to avoid blocking app startup
 */
async function loadOnlyOfficePlugin(manager) {
  try {
    const featuresStore = useFeaturesStore();
    await featuresStore.ensureLoaded();

    if (!featuresStore.onlyofficeEnabled) return;

    // Get supported extensions from store
    const extensions = normalizeExtensions(featuresStore.onlyofficeExtensions);
    manager.register(onlyofficePreviewPlugin(extensions));

    console.info(`ONLYOFFICE plugin loaded (${extensions.length} extensions)`);
  } catch (error) {
    console.debug('ONLYOFFICE plugin unavailable:', error.message);
  }
}

/**
 * Load Collabora plugin conditionally based on server features
 * Runs async to avoid blocking app startup
 */
async function loadCollaboraPlugin(manager) {
  try {
    const featuresStore = useFeaturesStore();
    await featuresStore.ensureLoaded();

    if (!featuresStore.collaboraEnabled) return;

    const extensions = normalizeExtensions(featuresStore.collaboraExtensions);
    manager.register(collaboraPreviewPlugin(extensions));

    console.info(`Collabora plugin loaded (${extensions.length} extensions)`);
  } catch (error) {
    console.debug('Collabora plugin unavailable:', error.message);
  }
}

/**
 * Normalize extension list from server
 */
function normalizeExtensions(extensions) {
  if (!Array.isArray(extensions)) {
    return [];
  }

  return extensions
    .filter((ext) => ext && typeof ext === 'string')
    .map((ext) => ext.toLowerCase().trim())
    .map((ext) => (ext.startsWith('.') ? ext.slice(1) : ext))
    .filter((ext) => ext.length > 0);
}
