<script setup>
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import AuthLayout from '@/layouts/AuthLayout.vue';
import { LockClosedIcon, KeyIcon } from '@heroicons/vue/24/outline';
import { apiBase } from '@/api';
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

const loginIdentifier = ref('');
const loginPasswordValue = ref('');
const loginError = ref('');
const isSubmittingLogin = ref(false);

const statusError = computed(() => auth.lastError || '');
const supportsLocal = computed(() => auth.strategies?.local !== false);
const supportsOidc = computed(() => Boolean(auth.strategies?.oidc));
const returnedFromLogout = ref(window.sessionStorage.getItem('oidcSignedOut') === '1');

/**
 * Whether this screen is showing because a session ran out.
 *
 * A session ending is not an error anybody made, and until this said so the
 * only account of it was the row of failed requests it left behind.
 */
const sessionExpired = computed(() => route.query?.reason === 'expired');
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

  if (!supportsLocal.value && supportsOidc.value && !returnedFromLogout.value) {
    handleOidcLogin();
  }

  try {
    await featuresStore.ensureLoaded();

    // A public demo publishes its login anyway, so making visitors retype it is
    // friction for nothing. The server only ever sends this in demo mode, and
    // an empty form is left alone if someone has already started typing.
    const demoLogin = featuresStore.demoLogin;
    if (demoLogin && !loginIdentifier.value && !loginPasswordValue.value) {
      loginIdentifier.value = demoLogin.email;
      loginPasswordValue.value = demoLogin.password;
    }
  } catch (_) {
    // Non-fatal; version info is optional
  }
});

const resetErrors = () => {
  loginError.value = '';
  auth.clearError();
};

/**
 * The refusals this screen can say better than the server can.
 *
 * A sign-in that could not be started has two causes, and telling them apart is
 * the difference between an administrator checking their settings and an
 * administrator checking their provider. The server sends the code beside its
 * own sentence; anything not listed here keeps that sentence.
 */
const SIGN_IN_ERROR_MESSAGES = {
  AUTH_OIDC_NOT_CONFIGURED: 'errors.oidcNotConfigured',
  AUTH_OIDC_PROVIDER_UNAVAILABLE: 'errors.oidcProviderUnavailable',
};

const syncErrorFromRoute = (nextRoute) => {
  const query = nextRoute?.query || {};
  const errorCode = query.error_code;
  const errorDescription = query.error_description;
  const error = query.error;
  const known =
    typeof errorCode === 'string' ? SIGN_IN_ERROR_MESSAGES[errorCode.trim()] : undefined;
  const message = known
    ? t(known)
    : typeof errorDescription === 'string' && errorDescription.trim()
      ? errorDescription.trim()
      : typeof error === 'string' && error.trim()
        ? error.trim()
        : '';

  if (message && !loginError.value) {
    loginError.value = message;
  }

  if (
    typeof query.error === 'string' ||
    typeof query.error_description === 'string' ||
    typeof query.error_code === 'string'
  ) {
    const cleanedQuery = { ...query };
    delete cleanedQuery.error;
    delete cleanedQuery.error_description;
    delete cleanedQuery.error_code;
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

  if (!loginIdentifier.value.trim()) {
    loginError.value = t('errors.identifierRequired');
    return;
  }

  if (!loginPasswordValue.value) {
    loginError.value = t('errors.passwordRequired');
    return;
  }

  isSubmittingLogin.value = true;

  try {
    await auth.login({
      identifier: loginIdentifier.value.trim(),
      password: loginPasswordValue.value,
    });
    loginIdentifier.value = '';
    loginPasswordValue.value = '';
    redirectToDestination();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t('errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

const handleOidcLogin = () => {
  resetErrors();
  const returnTo = redirectTarget.value;
  const base = apiBase || '';
  // Our own route rather than the provider library's `/login`: that one is
  // mounted only where there is a provider to hand the sign-in to, so on the
  // installation that most needs telling — nothing configured, or configured
  // and not answering — it is not there at all, and the button led nowhere.
  // This one always answers, and says which of the two it was.
  const loginUrl = `${base}/api/auth/oidc/login`;
  const query = new URLSearchParams();
  if (returnTo && typeof returnTo === 'string') {
    query.set('redirect', returnTo);
  }
  if (returnedFromLogout.value) {
    query.set('prompt', 'login');
    window.sessionStorage.removeItem('oidcSignedOut');
    returnedFromLogout.value = false;
  }
  const finalUrl = query.size ? `${loginUrl}?${query.toString()}` : loginUrl;
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

    <!--
      Outside the form on purpose: an installation that signs in only through an
      identity provider renders no form, and that is the installation where a
      session expiring is most confusing.
    -->
    <p
      v-if="sessionExpired"
      class="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
      role="status"
      data-test="session-expired"
    >
      {{ t('auth.login.sessionExpired') }}
    </p>

    <form v-if="supportsLocal" class="space-y-5" @submit.prevent="handleLoginSubmit">
      <label class="block">
        <span class="block text-sm font-medium text-white/80">{{
          $t('auth.emailOrUsername')
        }}</span>
        <input
          id="login-identifier"
          v-model="loginIdentifier"
          type="text"
          autocomplete="username"
          :class="inputBaseClasses"
          :placeholder="$t('placeholders.emailOrUsername')"
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
