import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchFeatures } from '@/api';

export const useFeaturesStore = defineStore('features', () => {
  const publicUrl = ref('');
  const publicOrigin = ref('');
  // Every origin the app may legitimately be reached from (public + internal).
  const publicOrigins = ref([]);
  // Admin-configured upper bound (bytes) for the upload chunk size.
  const maxUploadChunkSizeBytes = ref(0);
  const editorExtensions = ref([]);
  // What the editor opens and what the preview will render are two different
  // limits over two different kinds of work, and a refusal has to be able to
  // name both.
  const editorMaxFileSizeBytes = ref(null);
  const previewMaxRenderBytes = ref(16 * 1024 * 1024);
  const searchIndexEnabled = ref(false);
  const hiddenFilePatterns = ref(['.', 'regex:\\.download$']);
  // Archive extraction formats supported by the server (7-Zip probe).
  const archiveExtensions = ref(['zip']);
  // Credentials to pre-fill on the sign-in form. Null unless the server is in
  // demo mode and was given credentials for it.
  const demoLogin = ref(null);
  const onlyofficeEnabled = ref(false);
  const onlyofficeExtensions = ref([]);
  const collaboraEnabled = ref(false);
  const collaboraExtensions = ref([]);
  const volumeUsageEnabled = ref(false);
  const folderSizeMode = ref('off');
  const folderSizeEnabled = ref(false);
  const personalEnabled = ref(false);
  const userVolumesEnabled = ref(false);
  const skipHome = ref(false);
  const terminalEnabled = ref(false);
  const terminalExtensions = ref([]);
  const version = ref('');
  const gitCommit = ref('');
  const gitBranch = ref('');
  const repoUrl = ref('');
  const isLoading = ref(false);
  const hasLoaded = ref(false);
  let initPromise = null;

  const initialize = async () => {
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      if (hasLoaded.value) {
        return;
      }

      isLoading.value = true;

      try {
        const features = await fetchFeatures();

        // Public URL / origin
        publicUrl.value = typeof features?.public?.url === 'string' ? features.public.url : '';
        publicOrigin.value =
          typeof features?.public?.origin === 'string' ? features.public.origin : '';
        publicOrigins.value = Array.isArray(features?.public?.origins)
          ? features.public.origins.filter((o) => typeof o === 'string' && o)
          : [];
        maxUploadChunkSizeBytes.value = Number.isFinite(features?.uploads?.maxChunkSizeBytes)
          ? features.uploads.maxChunkSizeBytes
          : 0;

        // Editor extensions
        editorMaxFileSizeBytes.value = Number.isFinite(features?.editor?.maxFileSizeBytes)
          ? features.editor.maxFileSizeBytes
          : null;
        searchIndexEnabled.value = features?.search?.index?.enabled === true;
        previewMaxRenderBytes.value = Number.isFinite(features?.preview?.maxRenderBytes)
          ? features.preview.maxRenderBytes
          : 16 * 1024 * 1024;
        editorExtensions.value = Array.isArray(features?.editor?.extensions)
          ? features.editor.extensions
          : [];

        // Hidden file patterns
        hiddenFilePatterns.value = Array.isArray(features?.hiddenFiles?.patterns)
          ? features.hiddenFiles.patterns
          : ['.', 'regex:\\.download$'];

        // Archive extraction formats
        archiveExtensions.value =
          Array.isArray(features?.archives?.extensions) && features.archives.extensions.length
            ? features.archives.extensions
            : ['zip'];

        // OnlyOffice
        demoLogin.value =
          features?.demoLogin?.email && features?.demoLogin?.password
            ? { email: features.demoLogin.email, password: features.demoLogin.password }
            : null;
        onlyofficeEnabled.value = Boolean(features?.onlyoffice?.enabled);
        onlyofficeExtensions.value = Array.isArray(features?.onlyoffice?.extensions)
          ? features.onlyoffice.extensions
          : [];

        // Collabora
        collaboraEnabled.value = Boolean(features?.collabora?.enabled);
        collaboraExtensions.value = Array.isArray(features?.collabora?.extensions)
          ? features.collabora.extensions
          : [];

        // Volume usage
        volumeUsageEnabled.value = Boolean(features?.volumeUsage?.enabled);

        // Folder size index
        folderSizeMode.value =
          typeof features?.folderSize?.mode === 'string' ? features.folderSize.mode : 'off';
        folderSizeEnabled.value = Boolean(features?.folderSize?.enabled);

        // Personal folders
        personalEnabled.value = Boolean(features?.personal?.enabled);

        // User volumes (per-user volume assignments)
        userVolumesEnabled.value = Boolean(features?.userVolumes?.enabled);

        // Navigation behavior
        skipHome.value = Boolean(features?.navigation?.skipHome);
        terminalEnabled.value = Boolean(features?.terminal?.enabled);
        terminalExtensions.value = Array.isArray(features?.terminal?.extensions)
          ? features.terminal.extensions
          : [];

        // Version information
        version.value = features?.version?.app || '';
        gitCommit.value = features?.version?.gitCommit || '';
        gitBranch.value = features?.version?.gitBranch || '';
        repoUrl.value = features?.version?.repoUrl || '';

        hasLoaded.value = true;
      } catch (error) {
        console.error('Failed to load features:', error);
        // Set defaults on error
        publicUrl.value = '';
        publicOrigin.value = '';
        publicOrigins.value = [];
        maxUploadChunkSizeBytes.value = 0;
        editorExtensions.value = [];
        editorMaxFileSizeBytes.value = null;
        previewMaxRenderBytes.value = 16 * 1024 * 1024;
        searchIndexEnabled.value = false;
        hiddenFilePatterns.value = ['.', 'regex:\\.download$'];
        archiveExtensions.value = ['zip'];
        demoLogin.value = null;
        onlyofficeEnabled.value = false;
        onlyofficeExtensions.value = [];
        collaboraEnabled.value = false;
        collaboraExtensions.value = [];
        volumeUsageEnabled.value = false;
        folderSizeMode.value = 'off';
        folderSizeEnabled.value = false;
        personalEnabled.value = false;
        userVolumesEnabled.value = false;
        skipHome.value = false;
        terminalEnabled.value = false;
        terminalExtensions.value = [];
      } finally {
        isLoading.value = false;
      }
    })();

    return initPromise;
  };

  const ensureLoaded = async () => {
    if (!hasLoaded.value && !isLoading.value) {
      await initialize();
    }
    if (initPromise) {
      await initPromise;
    }
  };

  return {
    publicUrl,
    publicOrigin,
    publicOrigins,
    maxUploadChunkSizeBytes,
    editorExtensions,
    editorMaxFileSizeBytes,
    previewMaxRenderBytes,
    searchIndexEnabled,
    hiddenFilePatterns,
    archiveExtensions,
    demoLogin,
    onlyofficeEnabled,
    onlyofficeExtensions,
    collaboraEnabled,
    collaboraExtensions,
    volumeUsageEnabled,
    folderSizeMode,
    folderSizeEnabled,
    personalEnabled,
    userVolumesEnabled,
    skipHome,
    terminalEnabled,
    terminalExtensions,
    version,
    gitCommit,
    gitBranch,
    repoUrl,
    isLoading,
    hasLoaded,
    initialize,
    ensureLoaded,
  };
});
