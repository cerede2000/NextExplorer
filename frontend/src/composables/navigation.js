import { useRouter, useRoute } from 'vue-router';
import { withViewTransition } from '@/utils';
import { isEditableExtension } from '@/config/editor';
import { usePreviewManager } from '@/plugins/preview/manager';
import { useAppSettings } from '@/stores/appSettings';
import { documentRoute } from '@/utils/documentRoute';

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
    const editable =
      isEditableExtension(extensionFromKind) || isEditableExtension(extensionFromName);
    const basePath = item.path ? `${item.path}/${name}` : name;
    const fullPath = basePath.replace(/^\/+/, '');
    const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/');

    // A tab of its own, when that is what this account asked for.
    //
    // One decision for every kind of file rather than one per plugin: a
    // spreadsheet and a photograph open the same way, because a preference that
    // holds for some files and not others is a preference nobody can predict.
    // Both addresses already exist — `/open` for anything with a preview,
    // `/editor` for anything the text editor opens — so this is the browser
    // being handed one of them instead of this page filling itself.
    if (appSettings.userSettings?.documentsOpenInNewTab) {
      // Asked once: matching a plugin builds a context and walks the list.
      const previewable = Boolean(previewManager.findPlugin(item));
      const target = previewable
        ? documentRoute(fullPath)
        : editable
          ? { path: `/editor/${encodedPath}` }
          : null;

      if (target) {
        // `noopener` because the page opened must not be able to reach back
        // into this one through `window.opener`.
        window.open(router.resolve(target).href, '_blank', 'noopener');
        return;
      }
    }

    // Files: try preview first (no view transition – avoids double animations)
    if (previewManager.open(item)) {
      return;
    }

    if (editable) {
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
