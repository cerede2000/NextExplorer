import { createRouter, createWebHistory } from 'vue-router';
import FolderView from '@/views/FolderView.vue';
import HomeView from '@/views/HomeView.vue';
import EditorView from '@/views/EditorView.vue';
import BrowserLayout from '@/layouts/BrowserLayout.vue';
import SearchResultsView from '@/views/SearchResultsView.vue';
import SettingsView from '@/views/settings/SettingsView.vue';
import SettingsBranding from '@/views/settings/SettingsBranding.vue';
import SettingsFilesThumbnails from '@/views/settings/SettingsFilesThumbnails.vue';
import SettingsFfmpeg from '@/views/settings/SettingsFfmpeg.vue';
import SettingsUploads from '@/views/settings/SettingsUploads.vue';
import SettingsSearchIndex from '@/views/settings/SettingsSearchIndex.vue';
import SettingsTabs from '@/views/settings/SettingsTabs.vue';
import SettingsFolderSize from '@/views/settings/SettingsFolderSize.vue';
import SettingsAccessControl from '@/views/settings/SettingsAccessControl.vue';
import SettingsComingSoon from '@/views/settings/SettingsComingSoon.vue';
import AdminUsers from '@/views/settings/AdminUsers.vue';
import SettingsPassword from '@/views/settings/SettingsPassword.vue';
import SettingsTwoFactor from '@/views/settings/SettingsTwoFactor.vue';
import SettingsPasskeys from '@/views/settings/SettingsPasskeys.vue';
import SettingsApiTokens from '@/views/settings/SettingsApiTokens.vue';
import DocumentView from '@/views/DocumentView.vue';
import SettingsActivity from '@/views/settings/SettingsActivity.vue';
import SettingsAbout from '@/views/settings/SettingsAbout.vue';
import SettingsUserPreferences from '@/views/settings/SettingsUserPreferences.vue';
import AuthSetupView from '@/views/AuthSetupView.vue';
import AuthLoginView from '@/views/AuthLoginView.vue';
import ShareLoginView from '@/views/ShareLoginView.vue';
import SharedWithMeView from '@/views/SharedWithMeView.vue';
import SharedByMeView from '@/views/SharedByMeView.vue';
import TrashView from '@/views/TrashView.vue';
import SettingsTrash from '@/views/settings/SettingsTrash.vue';
import SettingsFileVersions from '@/views/settings/SettingsFileVersions.vue';
import { useAuthStore } from '@/stores/auth';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';
import { folderRoute } from '@/utils/folderRoute';
import { documentRoute } from '@/utils/documentRoute';
import { useFolderScrollStore } from '@/stores/folderScroll';
import { useTabsStore } from '@/stores/tabs';
import { restorePermission } from './restorePermission';
import { shareTokenOf } from './shareToken';
import { folderPathOfRoute } from '@/utils/routeFolderPath';
import { getVolumes } from '@/api';
import { readGuestSession, resolveShareAccess } from '@/router/shareGuard';
import { loadAccountSettings } from '@/router/settingsGuard';
import { authRedirect } from '@/router/authRedirect';
import { skipHomeDestination } from '@/router/skipHome';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/browse/',
    },
    {
      path: '/settings',
      component: BrowserLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          component: SettingsView,
          children: [
            { path: '', redirect: '/settings/about' },
            {
              path: 'branding',
              component: SettingsBranding,
              meta: { requiresAdmin: true },
            },
            {
              path: 'files-thumbnails',
              component: SettingsFilesThumbnails,
              meta: { requiresAdmin: true },
            },
            {
              path: 'ffmpeg',
              component: SettingsFfmpeg,
              meta: { requiresAdmin: true },
            },
            {
              path: 'uploads',
              component: SettingsUploads,
              meta: { requiresAdmin: true },
            },
            {
              path: 'folder-size',
              component: SettingsFolderSize,
              meta: { requiresAdmin: true },
            },
            {
              path: 'tabs',
              component: SettingsTabs,
              meta: { requiresAdmin: true },
            },
            {
              path: 'search-index',
              component: SettingsSearchIndex,
              meta: { requiresAdmin: true },
            },
            {
              path: 'trash',
              component: SettingsTrash,
              meta: { requiresAdmin: true },
            },
            {
              path: 'file-versions',
              component: SettingsFileVersions,
              meta: { requiresAdmin: true },
            },
            {
              path: 'activity',
              component: SettingsActivity,
              meta: { requiresAdmin: true },
            },
            { path: 'account-password', component: SettingsPassword },
            { path: 'account-two-factor', component: SettingsTwoFactor },
            { path: 'account-passkeys', component: SettingsPasskeys },
            { path: 'account-api-tokens', component: SettingsApiTokens },
            { path: 'user-preferences', component: SettingsUserPreferences },
            {
              path: 'access-control',
              component: SettingsAccessControl,
              meta: { requiresAdmin: true },
            },
            // Admin-only placeholder routes
            {
              path: 'admin-overview',
              component: SettingsComingSoon,
              meta: { requiresAdmin: true },
            },
            {
              path: 'admin-users',
              component: AdminUsers,
              meta: { requiresAdmin: true },
            },
            {
              path: 'admin-mounts',
              component: SettingsComingSoon,
              meta: { requiresAdmin: true },
            },
            {
              path: 'admin-audit',
              component: SettingsComingSoon,
              meta: { requiresAdmin: true },
            },
            // Scaffolded routes
            { path: 'general', component: SettingsComingSoon },
            { path: 'appearance', component: SettingsComingSoon },
            { path: 'uploads-downloads', component: SettingsComingSoon },
            { path: 'performance', component: SettingsComingSoon },
            { path: 'logging', component: SettingsComingSoon },
            { path: 'integrations', component: SettingsComingSoon },
            { path: 'advanced', component: SettingsComingSoon },
            { path: 'about', component: SettingsAbout },
          ],
        },
      ],
    },
    /**
     * The two screens a pane holds most of the time, each a record of its own.
     *
     * They were children of `BrowserLayout`, which is now nothing but a
     * `<RouterView />` — and that passthrough had a cost nobody could see: the pane
     * the reader is in draws the router's own component, which was the *layout*,
     * while the pane beside it resolves the deepest one, which is the screen. Two
     * different components for the same address, so moving from one half to the
     * other rebuilt both screens: the listing was read again, the reader was put
     * back from memory, and a click that crossed into the other half was swallowed
     * whole — the row it was pressed on had been replaced before the button came up.
     *
     * Flat, both panes draw the same component and crossing costs nothing. The
     * addresses, the names and what each record allows are exactly as they were.
     */
    {
      path: '/browse',
      name: 'HomeView',
      component: HomeView,
      meta: { requiresAuth: true },
    },
    {
      path: '/browse/:path(.+)',
      name: 'FolderView',
      component: FolderView,
      // Allow guest access for share paths
      meta: { requiresAuth: true, allowGuest: true },
    },
    {
      path: '/shares/shared-with-me',
      name: 'SharedWithMe',
      component: SharedWithMeView,
      meta: { requiresAuth: true },
    },
    {
      path: '/shares/shared-by-me',
      name: 'SharedByMe',
      component: SharedByMeView,
      meta: { requiresAuth: true },
    },
    {
      path: '/trash',
      name: 'Trash',
      component: TrashView,
      meta: { requiresAuth: true },
    },
    {
      // A file in the trash, shown in the editor to be read: nothing there can
      // be saved. Its own path, so no volume name can ever collide with it.
      path: '/trash/view/:itemId/:entryPath(.*)*',
      name: 'TrashFileViewer',
      component: EditorView,
      meta: { requiresAuth: true },
    },
    {
      // An earlier version of a file, shown in the editor to be read. The file
      // is named by its path, a share path for a share's visitor.
      path: '/versions/view/:versionId/:path(.*)',
      name: 'VersionFileViewer',
      component: EditorView,
      meta: { requiresAuth: true, allowGuest: true },
    },
    {
      path: '/search',
      component: SearchResultsView,
      meta: { requiresAuth: true },
    },
    {
      // Two or three files side by side — see views/CompareView.vue. Loaded on
      // demand; nothing else needs the alignment.
      path: '/compare',
      name: 'CompareView',
      component: () => import('@/views/CompareView.vue'),
      meta: { requiresAuth: true },
    },
    /**
     * Everything a visitor with no account touches, under one prefix.
     *
     * A share used to send its visitor into `/browse/share/<token>`, which is the
     * prefix of the signed-in application — so anybody putting an authentication
     * proxy in front of this had to be told about that one too, and a rule meant to
     * open a public link ended up naming half the application. Every other file
     * manager keeps its public share under a prefix of its own: Nextcloud serves the
     * page, the password prompt and the download under `/s/{token}`, Filestash serves
     * the page and the files under `/s/{share}`, FileBrowser has a `/public` route
     * beside the `/files` one that requires an account.
     *
     * So does this now. The words after the token are the API's own — `browse`,
     * `editor` — which is also why nothing a share holds can be mistaken for one:
     * a file lives under one of them, never beside them.
     *
     * These are guest routes, not public ones. `public` means the guard returns
     * before it has asked anything, which is right for the door and wrong for the
     * rooms: what is behind them is somebody's files, and `resolveShareAccess`
     * decides who may see them.
     */
    {
      path: '/share/:token/browse/:path(.*)*',
      name: 'ShareBrowse',
      component: FolderView,
      meta: { requiresAuth: true, allowGuest: true },
    },
    {
      path: '/share/:token/editor/:sharedPath(.*)*',
      name: 'SharedEditor',
      component: EditorView,
      meta: { requiresAuth: true, allowGuest: true, sharedEditor: true },
    },
    /**
     * And what a visitor reads rather than edits — a PDF, a picture, a document in
     * ONLYOFFICE or Collabora.
     *
     * `/open/…` asks for an account, so a share holding anything with a preview sent
     * its visitor to the sign-in screen: the listing offered the file and opening it
     * refused. Here it is a guest route like the others, decided by the same
     * `resolveShareAccess`, and every byte still comes through `/api/share/<token>/…`
     * where the server checks the guest session for itself.
     */
    {
      path: '/share/:token/open/:path(.*)*',
      name: 'ShareDocument',
      component: DocumentView,
      meta: { requiresAuth: true, allowGuest: true },
    },
    /**
     * And two of them side by side, which the Versions panel offers for anything
     * that reads as lines of text: a version of a shared file against the file as
     * it is now. `/compare` asks for an account, so that offer sent a visitor to
     * the sign-in screen. The sides are named in the query as they are everywhere
     * else, by their logical paths — each inside this share — and each one is read
     * through `/api/share/<token>/…` like everything else here.
     */
    {
      path: '/share/:token/compare',
      name: 'ShareCompare',
      component: () => import('@/views/CompareView.vue'),
      meta: { requiresAuth: true, allowGuest: true },
    },
    // Where a share used to be. Links already handed out still resolve, and still
    // through the same guard: a redirect is a navigation like any other.
    {
      path: '/browse/share/:token/:path(.*)*',
      redirect: (to) => folderRoute(`share/${to.params.token}/${segmentsOf(to.params.path)}`),
    },
    {
      path: '/editor/share/:token/:sharedPath(.*)*',
      redirect: (to) => ({
        name: 'SharedEditor',
        params: { token: to.params.token, sharedPath: to.params.sharedPath },
      }),
    },
    {
      path: '/open/share/:token/:path(.*)*',
      redirect: (to) => documentRoute(`share/${to.params.token}/${segmentsOf(to.params.path)}`),
    },
    {
      path: '/editor/:path(.*)',
      component: EditorView,
      meta: { requiresAuth: true, allowGuest: true },
    },
    {
      // One document, at an address of its own — see views/DocumentView.vue.
      // Outside the browser layout on purpose: a document opened in its own
      // tab is the document, and nothing else.
      path: '/open/:path(.*)',
      component: DocumentView,
      meta: { requiresAuth: true },
    },
    {
      // One terminal, at an address of its own — see views/TerminalView.vue.
      //
      // No layout at all, and the page deliberately draws no terminal of its own:
      // every open shell belongs to `TerminalHost.vue`, which is mounted once in the
      // shell of the application and outlives every page *and* every layout. It used
      // to be inside the browser layout, which is not one thing — `/browse` and this
      // are two route records, so crossing between them destroys that layout and
      // builds another, and it took every shell with it. A terminal that is unmounted
      // is a shell that has been killed.
      //
      // Which also gives a shell the whole tab: the sidebar is for going somewhere,
      // and beside a shell its only answer was to leave the shell — easy to confuse
      // with a `cd` a keystroke away. The strip of tabs still leads out.
      path: '/terminal/:path(.*)*',
      name: 'TerminalView',
      component: () => import('@/views/TerminalView.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/auth/setup',
      name: 'auth-setup',
      component: AuthSetupView,
      meta: { authScreen: true },
    },
    {
      path: '/auth/login',
      name: 'auth-login',
      component: AuthLoginView,
      meta: { authScreen: true },
    },
    {
      path: '/share/:token',
      name: 'ShareLogin',
      component: ShareLoginView,
      meta: { public: true }, // Public route, doesn't require auth
    },
  ],
});

/** A `(.*)*` parameter, which vue-router hands over as an array of segments. */
const segmentsOf = (value) =>
  Array.isArray(value) ? value.filter(Boolean).join('/') : String(value || '');

const folderPathFromRoute = (route) =>
  route?.name === 'FolderView' || route?.name === 'ShareBrowse' ? folderPathOfRoute(route) : '';

router.beforeEach(async (to, from) => {
  const folderScrollStore = useFolderScrollStore();
  const destinationPath = folderPathFromRoute(to);
  const sourcePath = folderPathFromRoute(from);
  const restore = restorePermission({
    destination: destinationPath,
    source: sourcePath,
    // The tab this walk belongs to: the window has one address and it is the tab in
    // front's. A permission keyed by the folder alone is one any other tab on that
    // folder would consume, and jump to where this one had been.
    travelling: useTabsStore().activeId,
  });
  if (restore) {
    if (restore.permitted) {
      folderScrollStore.permitRestore(restore.path, restore.tabId);
    } else {
      folderScrollStore.preventRestore(restore.path, restore.tabId);
    }
  }

  const auth = useAuthStore();
  const appSettings = useAppSettings();

  // Allow public routes (like share links) without auth
  const isPublicRoute = Boolean(to.meta?.public);
  if (isPublicRoute) {
    return true;
  }

  // Allow guest access for share paths (check if path starts with share/)
  const isGuestRoute = Boolean(to.meta?.allowGuest);
  const shareToken = shareTokenOf(to);

  if (isGuestRoute && shareToken) {
    // Read this first: initialize() drops the guest session as soon as it sees
    // a signed-in user, and it is the only proof that a signed-in visitor
    // already cleared the password on a protected link.
    const guestSession = readGuestSession();

    // Initialize auth if needed to check authentication status
    if (!auth.hasStatus && !auth.isLoading) {
      await auth.initialize();
    } else if (auth.isLoading) {
      await auth.initialize();
    }

    const decision = await resolveShareAccess({
      shareToken,
      fullPath: to.fullPath,
      auth,
      guestSession,
    });
    // Handed over here rather than at the end of the guard, so the settings
    // are asked for here too — see settingsGuard.js.
    if (decision === true) await loadAccountSettings({ auth, appSettings });
    return decision;
  }

  // Initialize auth store
  if (!auth.hasStatus && !auth.isLoading) {
    await auth.initialize();
  } else if (auth.isLoading) {
    await auth.initialize();
  }

  const isAuthRoute = Boolean(to.meta?.authScreen);

  const redirect = authRedirect(to, auth);
  if (redirect) return redirect;

  // Ensure app settings are loaded for authenticated sessions.
  // This prevents deep-link refreshes (e.g. /browse/some/path) from leaving `appSettings.loaded`
  // false forever, which blocks thumbnail requests and other settings-gated UI.
  if (!isAuthRoute) await loadAccountSettings({ auth, appSettings });

  // Optional UX: when configured, skip the home dashboard and
  // jump straight into the only available volume (single-volume setups).
  if (to.name === 'HomeView') {
    const destination = await skipHomeDestination({
      appSettings,
      featuresStore: useFeaturesStore(),
      getVolumes,
    });
    if (destination) return destination;
  }

  // Enforce admin-only routes if flagged
  const requiresAdmin = Boolean(to.meta && to.meta.requiresAdmin);
  if (requiresAdmin) {
    const isAdmin =
      Array.isArray(auth.currentUser?.roles) && auth.currentUser.roles.includes('admin');
    if (!isAdmin) {
      // send to a non-admin settings landing
      return { path: '/settings/about' };
    }
  }

  return true;
});

export default router;
