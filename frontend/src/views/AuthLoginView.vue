<script setup>
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import AuthLayout from '@/layouts/AuthLayout.vue';
import { LockClosedIcon, KeyIcon, FingerPrintIcon } from '@heroicons/vue/24/outline';
import { apiBase, passkeysSupported } from '@/api';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';

const auth = useAuthStore();
const featuresStore = useFeaturesStore();
const appSettings = useAppSettings();
const { t } = useI18n();
const router = useRouter();
const route = useRoute();

const loginEmailValue = ref('');
const loginPasswordValue = ref('');
const loginError = ref('');
const totpCodeValue = ref('');
/**
 * Whether offering a passkey would reach anything.
 *
 * The server says whether it takes them; the browser has the last word, since
 * a button that opens a dialog only to fail is worse than no button.
 */
const supportsPasskey = computed(() => Boolean(auth.strategies?.passkey) && passkeysSupported());
const isSubmittingTotp = ref(false);
const isSubmittingLogin = ref(false);

const statusError = computed(() => auth.lastError || '');
const supportsLocal = computed(() => auth.strategies?.local !== false);
const supportsOidc = computed(() => Boolean(auth.strategies?.oidc));
const redirectTarget = computed(() => {
  const redirect = route.query?.redirect;
  if (typeof redirect === 'string' && redirect.trim()) {
    return redirect;
  }
  return '/browse/';
});

const inputBaseClasses =
  'mt-2 w-full h-12 rounded-xl ring-1 ring-inset ring-white/10 bg-neutral-800/70 px-4 text-neutral-100 placeholder-neutral-500 focus:ring-white/60 focus:outline-hidden transition';

const helperTextClasses = 'text-sm text-red-400';

const redirectToDestination = () => {
  const target = redirectTarget.value;
  router.replace(typeof target === 'string' ? target : '/browse/');
};

const ensureAuthReady = async () => {
  if (!auth.hasStatus || auth.isLoading) {
    await auth.ensureStatus();
  }
};

onMounted(async () => {
  await ensureAuthReady();

  if (auth.requiresSetup) {
    const redirect = redirectTarget.value;
    router.replace({
      name: 'auth-setup',
      ...(redirect ? { query: { redirect } } : {}),
    });
    return;
  }

  if (auth.isAuthenticated) {
    redirectToDestination();
    return;
  }

  if (!supportsLocal.value && supportsOidc.value) {
    handleOidcLogin();
  }

  try {
    await featuresStore.ensureLoaded();
  } catch (_) {
    // Non-fatal; version info is optional
  }
});

const resetErrors = () => {
  loginError.value = '';
  auth.clearError();
};

const syncErrorFromRoute = (nextRoute) => {
  const query = nextRoute?.query || {};
  const errorDescription = query.error_description;
  const error = query.error;
  const message =
    typeof errorDescription === 'string' && errorDescription.trim()
      ? errorDescription.trim()
      : typeof error === 'string' && error.trim()
        ? error.trim()
        : '';

  if (message && !loginError.value) {
    loginError.value = message;
  }

  if (typeof query.error === 'string' || typeof query.error_description === 'string') {
    const cleanedQuery = { ...query };
    delete cleanedQuery.error;
    delete cleanedQuery.error_description;
    router.replace({ query: cleanedQuery });
  }
};

syncErrorFromRoute(route);
onBeforeRouteUpdate((to) => {
  syncErrorFromRoute(to);
});

const handleLoginSubmit = async () => {
  resetErrors();

  if (!supportsLocal.value) {
    loginError.value = t('errors.localSignInDisabled');
    return;
  }

  if (!loginEmailValue.value.trim()) {
    loginError.value = t('errors.emailRequired');
    return;
  }

  if (!loginPasswordValue.value) {
    loginError.value = t('errors.passwordRequired');
    return;
  }

  isSubmittingLogin.value = true;

  try {
    const outcome = await auth.login({
      email: loginEmailValue.value.trim(),
      password: loginPasswordValue.value,
    });
    loginPasswordValue.value = '';
    // The account wants a code as well: the form above takes over, and nothing
    // is signed in until it is answered.
    if (outcome?.totpRequired) return;
    loginEmailValue.value = '';
    redirectToDestination();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t('errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

/**
 * The second step.
 *
 * A code, or one off the paper: the server takes either, and which account this
 * is has been its to know since the password was right.
 */
const handleTotpSubmit = async () => {
  resetErrors();
  const code = totpCodeValue.value.trim();
  if (!code) {
    loginError.value = t('errors.totpCodeRequired');
    return;
  }

  isSubmittingTotp.value = true;
  try {
    await auth.submitTotpCode(code);
    totpCodeValue.value = '';
    redirectToDestination();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t('errors.signIn');
  } finally {
    isSubmittingTotp.value = false;
  }
};

const handlePasskeyLogin = async () => {
  resetErrors();
  isSubmittingLogin.value = true;
  try {
    const { totpRequired } = (await auth.signInWithPasskey()) ?? {};
    // A passkey that was not unlocked proves only that the device was there,
    // so an account asking for a code still asks for one.
    if (totpRequired) return;
    redirectToDestination();
  } catch (error) {
    // A browser that was closed, or somebody who changed their mind, both
    // arrive as NotAllowedError; neither is a failure worth shouting about.
    if (error?.name === 'NotAllowedError') return;
    loginError.value = error instanceof Error ? error.message : t('errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

const handleOidcLogin = () => {
  resetErrors();
  const returnTo = redirectTarget.value;
  const base = apiBase || '';
  // Prefer EOC's native /login route; Vite proxies /login to backend in dev.
  const loginUrl = `${base}/login`;
  const finalUrl =
    returnTo && typeof returnTo === 'string'
      ? `${loginUrl}?returnTo=${encodeURIComponent(returnTo)}`
      : loginUrl;
  window.location.href = finalUrl;
};
</script>

<template>
  <AuthLayout :version="featuresStore.version" :is-loading="auth.isLoading">
    <template #heading>
      <p class="text-3xl font-black leading-tight tracking-tight text-white">
        {{ $t('auth.login.welcome') }}
      </p>
    </template>

    <template #subtitle>
      <p class="mt-2 text-sm text-white/60">
        {{ t('auth.login.subtitle', { appName: appSettings.state.branding.appName }) }}
      </p>
    </template>

    <!-- The account asks for a code as well. The password step is behind this
         one on purpose: going back to it would start the sign-in again. -->
    <form v-if="auth.totpRequired" class="space-y-5" @submit.prevent="handleTotpSubmit">
      <label class="block">
        <span class="block text-sm font-medium text-white/80">{{ $t('auth.login.totpCode') }}</span>
        <input
          id="login-totp"
          v-model="totpCodeValue"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          :class="inputBaseClasses"
          :placeholder="$t('placeholders.totpCode')"
          :disabled="isSubmittingTotp"
        />
        <span class="mt-2 block text-xs text-white/60">{{ $t('auth.login.totpExplain') }}</span>
      </label>

      <p v-if="loginError" :class="helperTextClasses">{{ loginError }}</p>

      <button
        type="submit"
        class="w-full h-12 px-4 rounded-xl bg-neutral-100 hover:bg-neutral-100/90 active:bg-neutral-100/70 font-semibold text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isSubmittingTotp"
      >
        <span v-if="isSubmittingTotp">{{ $t('common.verifying') }}</span>
        <span v-else>{{ $t('auth.login.totpSubmit') }}</span>
      </button>
    </form>

    <form v-else-if="supportsLocal" class="space-y-5" @submit.prevent="handleLoginSubmit">
      <label class="block">
        <span class="block text-sm font-medium text-white/80">{{ $t('auth.emailAddress') }}</span>
        <input
          id="login-email"
          v-model="loginEmailValue"
          type="email"
          autocomplete="email"
          :class="inputBaseClasses"
          :placeholder="$t('placeholders.emailCompany')"
          :disabled="isSubmittingLogin"
        />
      </label>

      <label class="block">
        <span class="block text-sm font-medium text-white/80">{{ $t('common.password') }}</span>
        <input
          id="login-password"
          v-model="loginPasswordValue"
          type="password"
          autocomplete="current-password"
          :class="inputBaseClasses"
          placeholder="••••••••"
          :disabled="isSubmittingLogin"
        />
        <div class="mt-2 mb-4 text-right">
          <!-- <button
            type="button"
            class="text-xs font-medium text-white/70 underline-offset-4 hover:text-white hover:underline"
            @click="showResetInfo = true"
          >
            Forgot password?
          </button> -->
        </div>
      </label>

      <p v-if="loginError" :class="helperTextClasses">{{ loginError }}</p>
      <p v-else-if="statusError" :class="helperTextClasses">
        {{ statusError }}
      </p>

      <button
        type="submit"
        class="w-full h-12 px-4 rounded-xl bg-neutral-100 hover:bg-neutral-100/90 active:bg-neutral-100/70 font-semibold text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isSubmittingLogin"
      >
        <span v-if="isSubmittingLogin">{{ $t('common.verifying') }}</span>
        <span v-else class="inline-flex items-center gap-2">
          <LockClosedIcon class="h-5 w-5" />
          {{ $t('auth.login.submit') }}
        </span>
      </button>
    </form>

    <div v-if="supportsPasskey && !auth.totpRequired" class="mt-3">
      <button
        class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-700/50 px-4 text-sm font-medium text-white ring-1 ring-inset ring-white/10 enabled:hover:bg-neutral-700/70 enabled:active:bg-neutral-700/90 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        :disabled="isSubmittingLogin"
        data-test="passkey-sign-in"
        @click="handlePasskeyLogin"
      >
        <FingerPrintIcon class="h-5 w-5" />
        <span class="truncate">{{ $t('auth.passkey.signIn') }}</span>
      </button>
    </div>

    <div v-if="supportsLocal && supportsOidc" class="my-4 flex items-center gap-4">
      <div class="h-px w-full bg-white/10"></div>
      <span class="text-xs text-white/50">{{ $t('common.or') }}</span>
      <div class="h-px w-full bg-white/10"></div>
    </div>

    <div v-if="supportsOidc" class="mb-2">
      <button
        class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-700/50 hover:bg-neutral-700/70 active:bg-neutral-700/90 px-4 text-sm font-medium text-white ring-1 ring-inset ring-white/10"
        type="button"
        @click="handleOidcLogin"
      >
        <KeyIcon class="h-5 w-5" />
        <span class="truncate">{{ $t('auth.sso.continue') }}</span>
      </button>
    </div>

    <p v-if="!supportsLocal && (loginError || statusError)" class="mt-4" :class="helperTextClasses">
      {{ loginError || statusError }}
    </p>
  </AuthLayout>
</template>
