import { computed, ref } from 'vue';
import { browse } from '@/api';
import logger from '@/utils/logger';

/**
 * Walking the user's storage inside a dialog.
 *
 * Two dialogs need this: picking a file to hand to the editor, and picking a
 * folder to move things into. They differ in what they do with what they find,
 * not in how they find it — so the walking lives here and each dialog keeps its
 * own idea of what a valid choice is.
 */
export function useStorageBrowser() {
  const currentPath = ref('');
  const items = ref([]);
  const isLoading = ref(false);
  const error = ref('');

  const crumbs = computed(() => {
    const segments = String(currentPath.value || '')
      .split('/')
      .filter(Boolean);
    return segments.map((name, index) => ({
      name,
      path: segments.slice(0, index + 1).join('/'),
    }));
  });

  const navigate = async (target) => {
    isLoading.value = true;
    error.value = '';
    try {
      const listing = await browse(target || '');
      currentPath.value = listing?.path ?? target ?? '';
      items.value = Array.isArray(listing?.items) ? listing.items : [];
    } catch (browseError) {
      logger.debug('Storage browser could not list the folder', browseError);
      error.value = browseError?.message || '';
      items.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  /** The path of an entry in the current listing. */
  const fullPath = (item) => {
    const parent = item?.path || '';
    return parent ? `${parent}/${item.name}` : item?.name || '';
  };

  return {
    currentPath,
    items,
    isLoading,
    error,
    crumbs,
    navigate,
    fullPath,
  };
}
