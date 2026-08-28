import { useRouter, useRoute } from 'vue-router';
import { withViewTransition } from '@/utils';
import { isEditableExtension } from '@/config/editor';
import { usePreviewManager } from '@/plugins/preview/manager';
import { useAppSettings } from '@/stores/appSettings';

// Kept beside the markdown preview plugin's own list, which matches the same
// two extensions.
const MARKDOWN_EXTENSIONS = ['md', 'markdown'];

export function useNavigation() {
  const router = useRouter();
  const route = useRoute();
  const previewManager = usePreviewManager();
  const appSettings = useAppSettings();

  const navigate = withViewTransition((to) => router.push(to));
  const goPrev = withViewTransition(() => router.back());
  const goNext = withViewTransition(() => router.forward());

  const openItem = (item) => {
    if (!item) return;

    const kind = typeof item.kind === 'string' ? item.kind : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name && kind !== 'personal') return;
    const currentPath =
      typeof route.params.path === 'string'
        ? route.params.path
        : Array.isArray(route.params.path)
          ? route.params.path.join('/')
          : '';

    if (kind === 'volume') {
      navigate({ name: 'FolderView', params: { path: name } });
      return;
    }
    if (kind === 'personal') {
      navigate({ name: 'FolderView', params: { path: 'personal' } });
      return;
    }
    if (kind === 'directory') {
      const newPath = currentPath ? `${currentPath}/${name}` : name;
      navigate({ name: 'FolderView', params: { path: newPath } });
      return;
    }

    const extensionFromKind = kind.toLowerCase();
    const extensionFromName = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

    // Markdown is the one kind of file that has both a preview and an editor,
    // so it is the only one where opening it is a choice. Whoever mostly writes
    // markdown was going through the preview and clicking Edit every time
    // (#347); this sends them straight where they were heading. Everything else
    // keeps preview-first: an image or a video has no editor to go to.
    const opensInEditor =
      appSettings.userSettings?.markdownOpensInEditor &&
      (MARKDOWN_EXTENSIONS.includes(extensionFromKind) ||
        MARKDOWN_EXTENSIONS.includes(extensionFromName));

    // Files: try preview first (no view transition – avoids double animations)
    if (!opensInEditor && previewManager.open(item)) {
      return;
    }

    if (isEditableExtension(extensionFromKind) || isEditableExtension(extensionFromName)) {
      const basePath = item.path ? `${item.path}/${name}` : name;
      const fileToEdit = basePath.replace(/^\/+/, '');
      // Encode each segment for editor path
      const encodedPath = fileToEdit.split('/').map(encodeURIComponent).join('/');
      navigate({ path: `/editor/${encodedPath}` });
      return;
    }
  };

  const openBreadcrumb = (path) => {
    if (path === 'share') {
      navigate({ name: 'SharedWithMe' });
      return;
    }
    if (!path) {
      navigate({ name: 'HomeView' });
      return;
    }
    navigate({ name: 'FolderView', params: { path } });
  };

  const goUp = () => {
    const currentPath =
      typeof route.params.path === 'string'
        ? route.params.path
        : Array.isArray(route.params.path)
          ? route.params.path.join('/')
          : '';
    const segments = currentPath.split('/').filter(Boolean);
    if (segments.length === 0) return;

    segments.pop();
    const newPath = segments.join('/');
    if (newPath) {
      navigate({ name: 'FolderView', params: { path: newPath } });
      return;
    }
    navigate({ name: 'HomeView' });
  };

  return {
    openItem,
    openBreadcrumb,
    goNext,
    goPrev,
    goUp,
  };
}
