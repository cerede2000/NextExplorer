import { useRouter, useRoute } from 'vue-router';
import { withViewTransition } from '@/utils';
import { folderRoute } from '@/utils/folderRoute';
import { documentRoute } from '@/utils/documentRoute';
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
      navigate(folderRoute(name));
      return;
    }
    if (kind === 'personal') {
      navigate(folderRoute('personal'));
      return;
    }
    if (kind === 'directory') {
      const newPath = currentPath ? `${currentPath}/${name}` : name;
      navigate(folderRoute(newPath));
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

    const basePath = item.path ? `${item.path}/${name}` : name;
    const fullPath = basePath.replace(/^\/+/, '');
    const editable =
      isEditableExtension(extensionFromKind) || isEditableExtension(extensionFromName);

    // A tab of its own, when that is what this account asked for.
    //
    // One decision for every kind of file rather than one per plugin: a
    // spreadsheet and a photograph open the same way, because a preference
    // that holds for some files and not others is a preference nobody can
    // predict. Both addresses already exist — `/open` for anything with a
    // preview, `/editor` for anything the text editor opens — so this is the
    // browser being handed one of them instead of this page filling itself.
    if (appSettings.userSettings?.documentsOpenInNewTab) {
      const target =
        opensInEditor || (!previewManager.findPlugin(item) && editable)
          ? { path: `/editor/${fullPath.split('/').map(encodeURIComponent).join('/')}` }
          : previewManager.findPlugin(item)
            ? documentRoute(fullPath)
            : null;

      if (target) {
        // `noopener` because the page opened must not be able to reach back
        // into this one through `window.opener`.
        window.open(router.resolve(target).href, '_blank', 'noopener');
        return;
      }
    }

    // Files: try preview first (no view transition – avoids double animations)
    if (!opensInEditor && previewManager.open(item)) {
      return;
    }

    if (editable) {
      // Encode each segment for editor path
      const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/');
      navigate({ path: `/editor/${encodedPath}` });
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
    navigate(folderRoute(path));
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
      navigate(folderRoute(newPath));
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
