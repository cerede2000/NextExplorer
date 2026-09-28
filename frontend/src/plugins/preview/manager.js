import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import {
  getPreviewUrl,
  normalizePath,
  downloadItems,
  fetchFileContent,
  fetchMediaTracks,
  getSubtitleUrl,
} from '@/api';
import { useFileStore } from '@/stores/fileStore';
import { useTabsStore } from '@/stores/tabs';
import { createPreviewSession } from './session';
import router from '@/router';

/**
 * Which plugin opens what, and what each tab is showing.
 *
 * The register of plugins belongs to the window: one list, sorted once, asked by
 * everything. What is *open* belongs to a tab, and there is one session per tab —
 * see `session.js`. That split is the whole of what tabs changed here, and it is
 * what lets an ONLYOFFICE document go on existing while its reader looks at a
 * folder in another tab: the session is not torn down when the page showing it is,
 * because the page is not what it belongs to.
 *
 * The surface below is the one everything has always called: `open`, `close`,
 * `isOpen`, `activeItem` all mean "the tab in front", which is what they meant
 * when there was only ever one.
 */
export const usePreviewManager = defineStore('preview-manager', () => {
  const tabsStore = useTabsStore();
  const plugins = ref([]);

  /**
   * One session per tab, made when the tab is and ended when it goes.
   *
   * Ended, not dropped: a tab closed on an ONLYOFFICE document has to tell the
   * server that the editing session is over, exactly as closing the document
   * would. Before tabs that was the document page's business, on its way out;
   * now the page is not the last thing to know.
   */
  const sessions = new Map();
  const ensureSession = (key) => {
    if (!sessions.has(key)) sessions.set(key, createPreviewSession());
    return sessions.get(key);
  };

  for (const tab of tabsStore.tabs) ensureSession(tab.id);

  watch(
    () => tabsStore.tabs.map((tab) => tab.id),
    (ids) => {
      for (const id of ids) ensureSession(id);
      for (const id of [...sessions.keys()]) {
        if (ids.includes(id)) continue;
        void sessions.get(id).close();
        sessions.delete(id);
      }
    }
  );

  /** The session of the tab in front. Never null: there is always a tab. */
  const activeSession = computed(() => ensureSession(tabsStore.activeId));

  const activeItem = computed(() => activeSession.value.item.value);
  const activePlugin = computed(() => activeSession.value.plugin.value);
  const isOpen = computed(() => activeSession.value.isOpen.value);

  /**
   * One surface per tab, in the order of the tabs.
   *
   * What `PreviewHost` renders: all of them, all of the time, with only the one
   * in front visible. They are not rendered one at a time on purpose — a surface
   * that is unmounted and mounted again is a new one, and ONLYOFFICE would open
   * the document from scratch each time a reader came back to its tab.
   *
   * Every tab and not only the ones holding something: a surface whose session is
   * empty draws nothing, and keeping it means opening and closing a document is
   * the same fade in and out of one component it has always been.
   */
  const surfaces = computed(() =>
    tabsStore.tabs.map((tab) => ({ key: tab.id, session: ensureSession(tab.id) }))
  );

  const getExtension = (item) => {
    if (!item) return '';
    const kind = String(item.kind || '').toLowerCase();
    if (kind && kind !== 'directory') return kind;

    const name = String(item.name || '');
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : '';
  };

  // Helper: Build full path
  const getFullPath = (item) => {
    if (!item?.name) return '';
    const parent = normalizePath(item.path || '');
    return normalizePath(parent ? `${parent}/${item.name}` : item.name);
  };

  // Get siblings from the same directory
  const getSiblings = () => {
    const fileStore = useFileStore();
    const items = fileStore.getCurrentPathItems || [];
    return items;
  };

  /**
   * What a plugin is given.
   *
   * `key` is the tab this will be shown in, so that a document closing itself
   * closes its own session and not whichever one happens to be in front. It is
   * absent when the context is built only to ask *whether* something has a
   * plugin, and then closing falls back to the tab in front, as it always did.
   */
  const createApi = (item, key) => ({
    getPreviewUrl: (targetItem) => getPreviewUrl(getFullPath(targetItem || item)),
    getMediaTracks: (targetItem) => fetchMediaTracks(getFullPath(targetItem || item)),
    getSubtitleUrl: (targetItem, track) => getSubtitleUrl(getFullPath(targetItem || item), track),
    fetchContent: () => fetchFileContent(getFullPath(item)),
    getSiblings: (target) => getSiblings(target || item),
    openEditor: () => {
      const path = getFullPath(item);
      if (path) {
        // Encode each segment to handle special characters like #
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        router.push({ path: `/editor/${encodedPath}` });
      }
    },
    download: async (targetItem = item) => {
      const path = getFullPath(targetItem);
      if (!path) return;

      const response = await downloadItems([path]);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = targetItem.name || 'download';
      link.click();

      URL.revokeObjectURL(url);
    },
    close: () => (key === undefined ? close() : closeIn(key)),
  });

  // Plugin Management
  const register = (plugin) => {
    if (!plugin?.id) return;

    // Remove existing plugin with same id
    plugins.value = plugins.value.filter((p) => p.id !== plugin.id);

    // Add and sort by priority (descending)
    plugins.value.push(plugin);
    plugins.value.sort((a, b) => {
      const priorityA = a.priority ?? 0;
      const priorityB = b.priority ?? 0;
      return priorityB - priorityA || a.id.localeCompare(b.id);
    });
  };

  const unregister = (pluginId) => {
    plugins.value = plugins.value.filter((p) => p.id !== pluginId);
  };

  // Find matching plugin
  const findPlugin = (item, key) => {
    if (!item) return null;

    const extension = getExtension(item);
    const fullPath = getFullPath(item);
    const previewUrl = getPreviewUrl(fullPath);
    const api = createApi(item, key);

    const context = {
      item: { ...item },
      extension,
      filePath: fullPath,
      previewUrl,
      // Preview components can keep small, ephemeral state which their
      // lifecycle hooks need when the preview is about to close.
      previewState: {},
      api,
    };

    // Find first matching plugin
    for (const plugin of plugins.value) {
      try {
        if (plugin.match?.(context)) {
          return { plugin, context };
        }
      } catch (error) {
        console.error(`Plugin ${plugin.id} match error:`, error);
      }
    }

    return null;
  };

  /**
   * Whether a tab is already showing this exact document.
   *
   * Asked before opening, by the page that a tab coming forward mounts again:
   * the answer is what stops it rebuilding what is already there.
   */
  const shows = (key, item) => {
    if (!item) return false;
    return sessions.get(key)?.shows({ filePath: getFullPath(item), item }) ?? false;
  };

  /**
   * Whether a given tab is showing anything at all.
   *
   * Asked by the document page about *its own* tab rather than about whichever
   * is in front: a document closing itself is the reader pressing a cross, and a
   * session ending because its tab went is not. Deliberately does not make a
   * session it cannot find — a tab that has gone should not come back as an empty
   * one because somebody asked about it on the way out.
   */
  const isOpenIn = (key) => sessions.get(key)?.isOpen.value ?? false;

  /** Open a document in a given tab, and say whether anything opens it at all. */
  const openIn = (key, item) => {
    const match = findPlugin(item, key);
    if (!match) return false;

    const session = ensureSession(key);
    // Asked for what is already here — the same document opened twice from the
    // same tab. Left exactly as it is, rather than built again underneath
    // somebody who may be halfway through a sentence.
    if (session.shows(match.context)) return true;

    session.show(match.plugin, match.context);
    return true;
  };

  const open = (item) => openIn(tabsStore.activeId, item);

  const closeIn = (key) => sessions.get(key)?.close();
  const close = () => activeSession.value.close();

  /**
   * The window is going away — every session, not only the one in front.
   *
   * A document being edited in a background tab is being edited: it has a
   * session on the server and the server has to be told. Answers whether any of
   * them had something to say.
   */
  const endForUnload = () => {
    let spoke = false;
    for (const session of sessions.values()) spoke = session.endForUnload() || spoke;
    return spoke;
  };

  return {
    // State
    plugins,
    isOpen,
    activeItem,
    activePlugin,
    surfaces,

    // Actions
    register,
    unregister,
    open,
    openIn,
    shows,
    isOpenIn,
    close,
    closeIn,
    endForUnload,
    findPlugin,
  };
});
