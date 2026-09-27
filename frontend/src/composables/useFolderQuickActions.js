import { useRoute } from 'vue-router';
import { useFileStore } from '@/stores/fileStore';
import { useFavoritesStore } from '@/stores/favorites';
import { useFavoriteEditor } from '@/composables/useFavoriteEditor';
import { useInfoPanelStore } from '@/stores/infoPanel';
import { normalizePath } from '@/api';

// Quick actions for the current folder (the name shown at the top of the toolbar).
// The toolbar lives outside the ExplorerContextMenu provider, so this only offers
// the dialog-free subset that operates on a path directly — no selection needed,
// nothing that could act destructively on the folder the user is inside.
const FOLDER_ACTION_IDS = ['info', 'favorite', 'copyName', 'copyPath'];

export function useFolderQuickActions() {
  const route = useRoute();
  const fileStore = useFileStore();
  const favoritesStore = useFavoritesStore();
  const infoPanel = useInfoPanelStore();
  const { openEditorForFavorite } = useFavoriteEditor();

  const currentPath = () => {
    const p = route.params.path;
    const raw = Array.isArray(p) ? p.join('/') : p || fileStore.getCurrentPath || '';
    return normalizePath(raw);
  };

  const folderItem = () => {
    const p = currentPath();
    const idx = p.lastIndexOf('/');
    return {
      name: idx >= 0 ? p.slice(idx + 1) : p,
      path: idx >= 0 ? p.slice(0, idx) : '',
      kind: 'directory',
    };
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard?.writeText?.(String(text || ''));
    } catch {
      // Clipboard unavailable (insecure context / denied) — ignore.
    }
  };

  const isFavorite = () => {
    const p = currentPath();
    return Boolean(p) && favoritesStore.isFavorite(p);
  };

  const available = (id) => Boolean(currentPath()) && FOLDER_ACTION_IDS.includes(id);

  const run = async (id) => {
    const p = currentPath();
    if (!p) return;
    switch (id) {
      case 'info':
        infoPanel.open(folderItem());
        break;
      case 'copyName':
        await copy(folderItem().name);
        break;
      case 'copyPath':
        await copy(p);
        break;
      case 'favorite':
        if (favoritesStore.isFavorite(p)) {
          await favoritesStore.removeFavorite(p);
        } else {
          const favorite = await favoritesStore.addFavorite({ path: p });
          if (favorite) openEditorForFavorite(favorite);
        }
        break;
      default:
        break;
    }
  };

  return { available, run, isFavorite, currentPath };
}
