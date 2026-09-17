import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  fetchAuthStatus,
  setupAccount as setupAccountApi,
  login as loginApi,
  signInWithPasskey as signInWithPasskeyApi,
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
    passkey: false,
  });
  // What the server's configuration pass concluded about single sign-on:
  // 'ready', 'not-configured' or 'unavailable'. The sign-in screen shows the
  // last two rather than sending somebody to a provider that cannot answer.
  const oidcStatus = ref('ready');
  const currentUser = ref(null);
  /**
   * The password was right, and the account asks for a code as well.
   *
   * Read back from the server on every start, not only set when a sign-in
   * happens here: a reload in the middle of one lands back on the code rather
   * than on a password screen that would start the whole thing again.
   */
  const totpPending = ref(false);
  const isLoading = ref(false);
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
        strategies.value = status?.strategies || { local: true, oidc: false, passkey: false };
        oidcStatus.value = status?.oidc?.status || 'ready';
        currentUser.value = status?.user || null;
        totpPending.value = Boolean(status?.totpPending);

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

  const login = async ({ identifier, password }) => {
    lastError.value = null;
    const response = await loginApi({ identifier, password });
    hasStatus.value = true;

    // Halfway: the password was right and a code is wanted as well. Nobody is
    // signed in until it arrives, so nothing here says anybody is.
    if (response?.totpRequired) {
      totpPending.value = true;
      currentUser.value = null;
      return { totpRequired: true };
    }

    totpPending.value = false;
    currentUser.value = response?.user || null;

    // Clear guest session when user logs in
    sessionStorage.removeItem('guestSessionId');
    return { totpRequired: false };
  };

  /**
   * Sign in with a passkey, which names nobody.
   *
   * The same two endings as a password: signed in, or waiting for a code. A
   * passkey that was unlocked — a fingerprint, a face, a PIN — is already the
   * second factor, so only one that was not lands here waiting.
   */
  const signInWithPasskey = async () => {
    lastError.value = null;
    const response = await signInWithPasskeyApi();
    hasStatus.value = true;

    if (response?.totpRequired) {
      totpPending.value = true;
      currentUser.value = null;
      return { totpRequired: true };
    }

    totpPending.value = false;
    currentUser.value = response?.user || null;
    sessionStorage.removeItem('guestSessionId');
    return { totpRequired: false };
  };

  /**
   * Finish a sign-in with the code from the phone, or one off the paper.
   *
   * @returns {Promise<{usedRecoveryCode: boolean, recoveryCodesLeft: number|null}>}
   */
  const submitTotpCode = async (code) => {
    lastError.value = null;
    const response = await submitTotpCodeApi(code);
    totpPending.value = false;
    currentUser.value = response?.user || null;
    sessionStorage.removeItem('guestSessionId');
    return {
      usedRecoveryCode: Boolean(response?.usedRecoveryCode),
      recoveryCodesLeft: response?.recoveryCodesLeft ?? null,
    };
  };

  /**
   * Back to the password, when somebody gives up on finding their phone.
   *
   * The server is told, rather than only the screen: it is the one holding the
   * half-open sign-in, and a page reload would otherwise come back to the code
   * for a step this person has already walked away from.
   */
  const cancelTotp = async () => {
    totpPending.value = false;
    try {
      await logoutApi();
    } catch (_) {
      // Nothing was signed in; a server that cannot be reached changes that.
    }
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
    totpPending.value = false;
  };

  /**
   * Drop the session locally, without telling the server.
   *
   * For a session that has already expired: there is nothing left to end, and
   * asking the server to end it would be one more request answered 401 — or,
   * where an identity provider is involved, a redirect to it that a fetch
   * cannot follow. `hasStatus` stays true so the navigation guard sends the
   * person to the login screen rather than pausing to ask the server who they
   * are, which is the question that just failed.
   */
  const forgetSession = () => {
    currentUser.value = null;
    // A session that is over is not one halfway through: whatever was waiting
    // for a code is gone with it, and the screen starts at the password.
    totpPending.value = false;
    hasStatus.value = true;
    lastError.value = null;
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
    oidcStatus,
    currentUser,
    totpPending,
    lastError,
    initialize,
    ensureStatus: initialize,
    setupAccount,
    login,
    signInWithPasskey,
    submitTotpCode,
    cancelTotp,
    logout,
    forgetSession,
    clearError,
    refreshCurrentUser,
  };
});
