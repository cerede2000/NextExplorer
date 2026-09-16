import { useFeaturesStore } from '@/stores/features';

/**
 * Opening an archive shows what is in it, rather than nothing.
 *
 * Which files count as archives is the server's answer, not a list kept here:
 * it depends on the formats its 7-Zip was built with, and it is the same list
 * the extraction offer is drawn from. A build without the RAR codec offers
 * neither, rather than offering one and failing at the other.
 */
export const archivePreviewPlugin = () => ({
  id: 'core-archive-preview',
  label: 'Archive',
  priority: 25,
  // The window is this component's own: the preview overlay fills the screen,
  // which is right for a photograph and wrong for a listing.
  standalone: true,

  match: (context) => {
    const extension = String(context.extension || '').toLowerCase();
    if (!extension) return false;
    const supported = useFeaturesStore().archiveExtensions;
    return Array.isArray(supported) && supported.includes(extension);
  },

  component: () => import('./ArchivePreview.vue'),
});
