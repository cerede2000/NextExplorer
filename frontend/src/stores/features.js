import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchFeatures } from '@/api';

export const useFeaturesStore = defineStore('features', () => {
  const publicUrl = ref('');
  const publicOrigin = ref('');
  // Every origin the app may legitimately be reached from (public + internal).
  const publicOrigins = ref([]);
  // The ceiling an administrator may raise the upload chunk size to.
  const maxUploadChunkSizeBytes = ref(0);
  // Archive formats the server-side 7-Zip build actually supports.
  const archiveExtensions = ref(['zip']);
  const editorExtensions = ref([]);
  const hiddenFilePatterns = ref(['.']);
  const onlyofficeEnabled = ref(false);
  const onlyofficeExtensions = ref([]);
  const collaboraEnabled = ref(false);
  const collaboraExtensions = ref([]);
  const volumeUsageEnabled = ref(false);
  const folderSizeMode = ref('off');
  const folderSizeLockedBy = ref(null);
  const searchIndexEnabled = ref(false);
  const searchIndexLockedBy = ref(null);
  const folderSizeEnabled = ref(false);
  const personalEnabled = ref(false);
  const userVolumesEnabled = ref(false);
  const skipHome = ref(false);
  const terminalEnabled = ref(false);
  // Whether deleting goes to the trash. The server already says so; nothing
  // read it, so the way into the trash could not be shown or hidden.
  const trashEnabled = ref(false);
  const trashRetentionDays = ref(null);
  // Whether a save keeps what it replaces as a version. The server already
  // said so; nothing read it, so a file's history could not be offered or
  // hidden.
  const versionsEnabled = ref(false);
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

        // Editor extensions
        editorExtensions.value = Array.isArray(features?.editor?.extensions)
          ? features.editor.extensions
          : [];

        // Hidden file patterns
        hiddenFilePatterns.value = Array.isArray(features?.hiddenFiles?.patterns)
          ? features.hiddenFiles.patterns
          : ['.'];

        // OnlyOffice
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
        folderSizeMode.value =
          typeof features?.folderSize?.mode === 'string' ? features.folderSize.mode : 'off';
        folderSizeEnabled.value = Boolean(features?.folderSize?.enabled);
        folderSizeLockedBy.value =
          typeof features?.folderSize?.lockedBy === 'string' ? features.folderSize.lockedBy : null;
        searchIndexEnabled.value = features?.search?.index?.enabled === true;
        searchIndexLockedBy.value =
          typeof features?.search?.index?.lockedBy === 'string'
            ? features.search.index.lockedBy
            : null;

        // Personal folders
        personalEnabled.value = Boolean(features?.personal?.enabled);
        trashEnabled.value = Boolean(features?.trash?.enabled);
        trashRetentionDays.value = features?.trash?.retentionDays ?? null;
        versionsEnabled.value = Boolean(features?.versions?.enabled);
        archiveExtensions.value = Array.isArray(features?.archives?.extensions)
          ? features.archives.extensions
          : ['zip'];
        maxUploadChunkSizeBytes.value = Number.isFinite(features?.uploads?.maxChunkSizeBytes)
          ? features.uploads.maxChunkSizeBytes
          : 0;

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
        editorExtensions.value = [];
        hiddenFilePatterns.value = ['.'];
        onlyofficeEnabled.value = false;
        onlyofficeExtensions.value = [];
        collaboraEnabled.value = false;
        collaboraExtensions.value = [];
        volumeUsageEnabled.value = false;
        folderSizeMode.value = 'off';
        folderSizeEnabled.value = false;
        folderSizeLockedBy.value = null;
        searchIndexEnabled.value = false;
        searchIndexLockedBy.value = null;
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
    editorExtensions,
    hiddenFilePatterns,
    onlyofficeEnabled,
    onlyofficeExtensions,
    collaboraEnabled,
    collaboraExtensions,
    volumeUsageEnabled,
    folderSizeMode,
    folderSizeLockedBy,
    searchIndexEnabled,
    searchIndexLockedBy,
    folderSizeEnabled,
    personalEnabled,
    userVolumesEnabled,
    skipHome,
    terminalEnabled,
    trashEnabled,
    trashRetentionDays,
    versionsEnabled,
    archiveExtensions,
    maxUploadChunkSizeBytes,
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
