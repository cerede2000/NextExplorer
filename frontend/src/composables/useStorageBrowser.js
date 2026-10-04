import { computed, ref } from 'vue';
import { browse, normalizePath } from '@/api';
import { shareRootForPage } from '@/api/shareScope';
import { useAuthStore } from '@/stores/auth';
import logger from '@/utils/logger';

/**
 * The top a dialog opened on this page must not go above.
 *
 * Only for a visitor with no account: an account reading a share has its own
 * storage above the share, and copying something out of one is a thing it does.
 */
export const confinedRoot = () => (useAuthStore().isGuest ? shareRootForPage() : '');

/**
 * Walking the user's storage inside a dialog.
 *
 * Two dialogs need this: picking a file to hand to the editor, and picking a
 * folder to move things into. They differ in what they do with what they find,
 * not in how they find it — so the walking lives here and each dialog keeps its
 * own idea of what a valid choice is.
 *
 * `root` is the top: nothing above it is reachable and its own segments are not
 * shown, because inside a share the top is the share and its token is not a
 * folder anybody chose. Empty — the ordinary case — means the storage's own top.
 */
export function useStorageBrowser() {
  const root = ref('');
  const currentPath = ref('');
  const items = ref([]);
  const isLoading = ref(false);
  const error = ref('');

  /** Where a target really is: itself, or the top when it is above it. */
  const within = (target) => {
    const top = normalizePath(root.value || '');
    const wanted = normalizePath(target || '');
    if (!top) return wanted;
    return wanted === top || wanted.startsWith(`${top}/`) ? wanted : top;
  };

  const crumbs = computed(() => {
    const top = normalizePath(root.value || '');
    const inside = normalizePath(currentPath.value || '');
    const below = top ? inside.slice(top.length) : inside;
    const segments = String(below).split('/').filter(Boolean);
    return segments.map((name, index) => ({
      name,
      path: [top, ...segments.slice(0, index + 1)].filter(Boolean).join('/'),
    }));
  });

  const navigate = async (target) => {
    const wanted = within(target);
    isLoading.value = true;
    error.value = '';
    try {
      const listing = await browse(wanted);
      currentPath.value = listing?.path ?? wanted;
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
    root,
    currentPath,
    items,
    isLoading,
    error,
    crumbs,
    navigate,
    fullPath,
  };
}
