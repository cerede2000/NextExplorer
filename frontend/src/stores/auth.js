import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  fetchAuthStatus,
  setupAccount as setupAccountApi,
  login as loginApi,
  submitTotpCode as submitTotpCodeApi,
  logout as logoutApi,
  fetchCurrentUser,
} from '@/api';

export const useAuthStore = defineStore('auth', () => {
  const requiresSetup = ref(false);
  const authEnabled = ref(true);
  const authMode = ref('local');
  const strategies = ref({
    local: true,
    oidc: false,
  });
  const currentUser = ref(null);
  const isLoading = ref(false);
  /**
   * Whether a sign-in is waiting for a code from an authenticator.
   *
   * The password was right; nothing about who they are is known here, and the
   * server is holding that.
   */
  const totpRequired = ref(false);
  const hasStatus = ref(false);
  const lastError = ref(null);
  let initPromise = null;

  const isAuthenticated = computed(() => {
    if (!authEnabled.value) {
      return true;
    }
    return Boolean(currentUser.value);
  });

  const isGuest = computed(() => {
    // Guest if we have a guest session but no authenticated user
    const guestSessionId = sessionStorage.getItem('guestSessionId');
    return Boolean(guestSessionId && !currentUser.value);
  });

  const initialize = async () => {
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      isLoading.value = true;
      lastError.value = null;

      try {
        const status = await fetchAuthStatus();
        const enabled = status?.authEnabled !== false;
        requiresSetup.value = enabled ? Boolean(status.requiresSetup) : false;
        authEnabled.value = enabled;
        authMode.value = typeof status?.authMode === 'string' ? status.authMode : 'local';
        strategies.value = status?.strategies || { local: true, oidc: false };
        currentUser.value = status?.user || null;
        // A reload in the middle of signing in lands back on the code rather
        // than on a password screen that would start the whole thing again.
        totpRequired.value = Boolean(status?.totpPending);

        // Clear guest session if user is now authenticated
        if (currentUser.value) {
          sessionStorage.removeItem('guestSessionId');
        }

        // Cookies hold session; no token adjustments needed
      } catch (error) {
        lastError.value =
          error instanceof Error ? error.message : 'Failed to load authentication status.';
      } finally {
        hasStatus.value = true;
        isLoading.value = false;
        initPromise = null;
      }
    })();

    return initPromise;
  };

  const setupAccount = async ({ email, username, password }) => {
    lastError.value = null;
    const response = await setupAccountApi({ email, username, password });
    requiresSetup.value = false;
    hasStatus.value = true;
    currentUser.value = response?.user || null;

    // Clear guest session when user sets up account
    sessionStorage.removeItem('guestSessionId');
  };

  const login = async ({ email, password }) => {
    lastError.value = null;
    const response = await loginApi({ email, password });
    if (response?.totpRequired) {
      totpRequired.value = true;
      return { totpRequired: true };
    }
    totpRequired.value = false;
    hasStatus.value = true;
    currentUser.value = response?.user || null;

    // Clear guest session when user logs in
    sessionStorage.removeItem('guestSessionId');
    return { totpRequired: false };
  };

  /** The second step. Which account this is remains the server's to know. */
  const submitTotpCode = async (code) => {
    lastError.value = null;
    const response = await submitTotpCodeApi(code);
    totpRequired.value = false;
    hasStatus.value = true;
    currentUser.value = response?.user || null;
    sessionStorage.removeItem('guestSessionId');
    return response;
  };

  const logout = async () => {
    lastError.value = null;
    try {
      await logoutApi();
    } catch (_) {
      // Ignore logout errors
    }
    hasStatus.value = true;
    currentUser.value = null;
  };

  const clearError = () => {
    lastError.value = null;
  };

  const refreshCurrentUser = async () => {
    try {
      const response = await fetchCurrentUser();
      currentUser.value = response?.user || null;
      return currentUser.value;
    } catch (error) {
      currentUser.value = null;
      throw error;
    }
  };

  return {
    requiresSetup,
    isLoading,
    hasStatus,
    isAuthenticated,
    isGuest,
    authEnabled,
    authMode,
    strategies,
    currentUser,
    lastError,
    initialize,
    ensureStatus: initialize,
    setupAccount,
    login,
    totpRequired,
    submitTotpCode,
    logout,
    clearError,
    refreshCurrentUser,
  };
});
