import { createRouter, createWebHistory } from 'vue-router';
import FolderView from '@/views/FolderView.vue';
import HomeView from '@/views/HomeView.vue';
import EditorView from '@/views/EditorView.vue';
import BrowserLayout from '@/layouts/BrowserLayout.vue';
import EditorLayout from '@/layouts/EditorLayout.vue';
import SearchResultsView from '@/views/SearchResultsView.vue';
import SettingsView from '@/views/settings/SettingsView.vue';
import SettingsBranding from '@/views/settings/SettingsBranding.vue';
import SettingsFilesThumbnails from '@/views/settings/SettingsFilesThumbnails.vue';
import SettingsUploads from '@/views/settings/SettingsUploads.vue';
import SettingsSearchIndex from '@/views/settings/SettingsSearchIndex.vue';
import SettingsFolderSize from '@/views/settings/SettingsFolderSize.vue';
import SettingsAccessControl from '@/views/settings/SettingsAccessControl.vue';
import SettingsComingSoon from '@/views/settings/SettingsComingSoon.vue';
import AdminUsers from '@/views/settings/AdminUsers.vue';
import SettingsPassword from '@/views/settings/SettingsPassword.vue';
import SettingsAbout from '@/views/settings/SettingsAbout.vue';
import SettingsUserPreferences from '@/views/settings/SettingsUserPreferences.vue';
import AuthSetupView from '@/views/AuthSetupView.vue';
import AuthLoginView from '@/views/AuthLoginView.vue';
import ShareLoginView from '@/views/ShareLoginView.vue';
import SharedWithMeView from '@/views/SharedWithMeView.vue';
import SharedByMeView from '@/views/SharedByMeView.vue';
import { useAuthStore } from '@/stores/auth';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';
import { useFolderScrollStore } from '@/stores/folderScroll';
import { getVolumes } from '@/api';
import { readGuestSession, resolveShareAccess } from '@/router/shareGuard';
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
              path: 'search-index',
              component: SettingsSearchIndex,
              meta: { requiresAdmin: true },
            },
            { path: 'account-password', component: SettingsPassword },
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
    {
      path: '/browse',
      component: BrowserLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'HomeView',
          component: HomeView,
        },
        {
          path: ':path(.+)',
          name: 'FolderView',
          component: FolderView,
          meta: { allowGuest: true }, // Allow guest access for share paths
        },
      ],
    },
    {
      path: '/shares',
      component: BrowserLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: 'shared-with-me',
          name: 'SharedWithMe',
          component: SharedWithMeView,
        },
        {
          path: 'shared-by-me',
          name: 'SharedByMe',
          component: SharedByMeView,
        },
      ],
    },
    {
      path: '/search',
      component: BrowserLayout,
      meta: { requiresAuth: true },
      children: [{ path: '', component: SearchResultsView }],
    },
    {
      path: '/editor',
      component: EditorLayout,
      meta: { requiresAuth: true, allowGuest: true },
      children: [
        {
          path: 'share/:token/:sharedPath(.*)*',
          name: 'SharedEditor',
          component: EditorView,
          meta: { sharedEditor: true },
        },
        {
          path: ':path(.*)',
          component: EditorView,
        },
      ],
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

const folderPathFromRoute = (route) => {
  if (route?.name !== 'FolderView') return '';
  const raw = Array.isArray(route.params?.path)
    ? route.params.path.join('/')
    : route.params?.path || '';
  return String(raw).replace(/^\/+|\/+$/g, '');
};

const isAncestorFolder = (candidate, current) =>
  Boolean(candidate && current && current.startsWith(`${candidate}/`));

router.beforeEach(async (to, from) => {
  const folderScrollStore = useFolderScrollStore();
  const destinationPath = folderPathFromRoute(to);
  const sourcePath = folderPathFromRoute(from);
  if (destinationPath) {
    if (isAncestorFolder(destinationPath, sourcePath)) {
      folderScrollStore.permitRestore(destinationPath);
    } else {
      folderScrollStore.preventRestore(destinationPath);
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
  const pathParam = typeof to.params?.path === 'string' ? to.params.path : '';
  const shareToken =
    to.name === 'SharedEditor'
      ? typeof to.params?.token === 'string'
        ? to.params.token
        : ''
      : pathParam.startsWith('share/')
        ? pathParam.split('/')[1]
        : '';

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

    return await resolveShareAccess({ shareToken, fullPath: to.fullPath, auth, guestSession });
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
  if (!isAuthRoute && auth.isAuthenticated) {
    try {
      await appSettings.ensureLoaded();
    } catch (_) {
      // Non-fatal; the UI will behave conservatively if settings aren't available.
    }
  }

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
