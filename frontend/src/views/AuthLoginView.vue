<script setup>
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';

import AuthLayout from '@/layouts/AuthLayout.vue';
import { FingerPrintIcon, LockClosedIcon, KeyIcon } from '@heroicons/vue/24/outline';
import { apiBase, passkeysSupported } from '@/api';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useFeaturesStore } from '@/stores/features';
import { useAppSettings } from '@/stores/appSettings';
import { markHandedOff, takeHandedOffRecently, takeSignedOut } from '@/utils/providerHandoff';

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
/** The code from the phone, or one off the paper, when the account asks. */
const totpCodeValue = ref('');

/**
 * Whether the server has said how anybody signs in here.
 *
 * Until it has, this screen offers nothing: every button below describes
 * something the server told us about, and the defaults it falls back to
 * describe a password form that an installation signing in through a provider
 * does not have. An unreachable server gets a sentence and a button to ask
 * again, which is the whole truth about it.
 */
const statusUnknown = computed(() => Boolean(auth.statusUnavailable));
const supportsLocal = computed(() => !statusUnknown.value && auth.strategies?.local !== false);
const supportsOidc = computed(() => !statusUnknown.value && Boolean(auth.strategies?.oidc));
/**
 * Whether to offer a passkey at all.
 *
 * Two answers have to agree: the server offers local accounts, and this
 * browser can do it — which over plain http it cannot, whatever it supports.
 * A button that opens a dialog only to fail is worse than no button.
 */
const supportsPasskey = computed(
  () => !statusUnknown.value && Boolean(auth.strategies?.passkey) && passkeysSupported()
);

/**
 * Whether pressing the single sign-on button would reach anything.
 *
 * The server knows already — its configuration pass either mounted the
 * hand-off or recorded why it could not — and until it said so here, the only
 * way to find out was to press the button, travel to the provider, and come
 * back to this screen with the answer. The two reasons are the two the round
 * trip reports, so they are said in the same words.
 */
const OIDC_STATUS_MESSAGES = {
  'not-configured': 'errors.oidcNotConfigured',
  unavailable: 'errors.oidcProviderUnavailable',
};
const oidcUnavailableMessage = computed(() => {
  const message = OIDC_STATUS_MESSAGES[auth.oidcStatus];
  return message ? t(message) : '';
});
/**
 * The two things that happened before this screen existed.
 *
 * Both are read once, here, and removed as they are read — see
 * utils/providerHandoff.js. A mark that outlives the screen it was left for
 * answers the wrong question later: the sign-out mark used to stop a hand-off
 * hours after the sign-out it described, and nothing ever cleared it.
 */
const returnedFromLogout = ref(takeSignedOut());
const providerSentThemBackWithNothing = ref(takeHandedOffRecently());

/**
 * Whether this screen is showing because a session ran out.
 *
 * A session ending is not an error anybody made, and until this said so the
 * only account of it was the row of failed requests it left behind.
 */
const sessionExpired = computed(() => route.query?.reason === 'expired');

/**
 * Nothing at all on offer.
 *
 * `AUTH_MODE=oidc` with no provider configured is the combination that gets
 * here, and what it used to draw was a heading, a subtitle and nothing else:
 * no field, no button, no sentence. An administrator reading that screen has
 * no way to know whether they are looking at a bug or at their own settings.
 */
const nothingOnOffer = computed(
  () =>
    !statusUnknown.value &&
    !auth.totpPending &&
    !supportsLocal.value &&
    !supportsOidc.value &&
    !supportsPasskey.value
);
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

/**
 * Why a hand-off to the provider must wait for somebody to ask for it.
 *
 * Going on its own is right where a provider is the only way in: a form nobody
 * can fill is a dead end. It is wrong in four cases, and each of them used to
 * be a screen somebody was stuck on:
 *
 *  - straight after a sign-out, or leaving would be a flicker and a return;
 *  - straight after a hand-off that came back without a session, which is the
 *    circle that spins a logo for as long as anybody will watch it;
 *  - when the provider knows this person and this installation has no account
 *    for them, which no number of further trips will change;
 *  - when the provider handed back an error, or the server said before the
 *    button was ever pressed that there is no provider to reach. The button
 *    is disabled for exactly that reason, and this path did it anyway —
 *    straight onto a page of raw JSON.
 */
const handOffIsHeldBack = computed(
  () =>
    returnedFromLogout.value ||
    providerSentThemBackWithNothing.value ||
    Boolean(auth.providerHasNoAccountHere) ||
    arrivedWithProviderError.value ||
    Boolean(oidcUnavailableMessage.value)
);

const handsOffOnItsOwn = computed(
  () => !supportsLocal.value && supportsOidc.value && !handOffIsHeldBack.value
);

/** What to say to somebody a trip to the provider left with nothing. */
const providerLeftThemOutside = computed(() => {
  if (auth.providerHasNoAccountHere) return t('auth.login.noAccountHere');
  if (providerSentThemBackWithNothing.value) return t('auth.login.cameBackWithoutSession');
  return '';
});

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

  if (handsOffOnItsOwn.value) {
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
  AUTH_INVALID_TOTP_CODE: 'errors.totpCodeWrong',
};

/** The server's sentence, or ours where we have one in this reader's language. */
const messageFor = (error, fallback) => {
  const known = SIGN_IN_ERROR_MESSAGES[error?.code];
  if (known) return t(known);
  return error instanceof Error && error.message ? error.message : t(fallback);
};

/**
 * Whether the provider handed something back in the address rather than a
 * session. Read on the way in, before anything decides to go there again.
 */
const arrivedWithProviderError = ref(false);

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
  if (message) {
    arrivedWithProviderError.value = true;
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
    const { totpRequired } =
      (await auth.login({
        identifier: loginIdentifier.value.trim(),
        password: loginPasswordValue.value,
      })) ?? {};
    loginIdentifier.value = '';
    loginPasswordValue.value = '';
    // Halfway: nobody is signed in yet, so nothing is redirected anywhere.
    if (totpRequired) return;
    redirectToDestination();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t('errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

const handleTotpSubmit = async () => {
  resetErrors();
  if (!totpCodeValue.value.trim()) {
    loginError.value = t('errors.totpCodeRequired');
    return;
  }

  isSubmittingLogin.value = true;
  try {
    await auth.submitTotpCode(totpCodeValue.value.trim());
    totpCodeValue.value = '';
    redirectToDestination();
  } catch (error) {
    loginError.value = messageFor(error, 'errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

/** Give up on finding the phone, and start again at the password. */
const handleTotpCancel = () => {
  resetErrors();
  totpCodeValue.value = '';
  auth.cancelTotp();
};

/**
 * Sign in with a passkey. Nobody is named: the browser offers what it holds
 * for this site, and a person who has none is told so by the browser itself.
 */
const handlePasskeyLogin = async () => {
  resetErrors();
  isSubmittingLogin.value = true;
  try {
    const { totpRequired } = (await auth.signInWithPasskey()) ?? {};
    if (totpRequired) return;
    redirectToDestination();
  } catch (error) {
    // A browser that was closed, or a person who changed their mind, both
    // arrive as NotAllowedError; neither is a failure worth shouting about.
    if (error?.name === 'NotAllowedError') return;
    loginError.value = messageFor(error, 'errors.signIn');
  } finally {
    isSubmittingLogin.value = false;
  }
};

/** Ask the server again how anybody signs in here. */
const isAskingAgain = ref(false);
const handleAskAgain = async () => {
  if (isAskingAgain.value) return;
  isAskingAgain.value = true;
  resetErrors();
  try {
    await auth.initialize();
  } finally {
    isAskingAgain.value = false;
  }
};

const handleOidcLogin = () => {
  resetErrors();
  // The server already said this one cannot be reached. Pressing on would
  // leave the application for an address that answers with a refusal nobody
  // can read, and no way back to this screen.
  if (oidcUnavailableMessage.value) return;
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
    returnedFromLogout.value = false;
  }
  const finalUrl = query.size ? `${loginUrl}?${query.toString()}` : loginUrl;
  // Written before leaving, read by whatever screen the browser comes back to.
  markHandedOff();
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

    <!--
      A trip to the provider that ended outside.

      Not an error anybody typed, and not a refusal of what they typed: the
      provider did its part and this installation has no session to show for
      it. Said here rather than left to the next hand-off, which is what used
      to happen — and that hand-off came back to this same screen, which handed
      off again.
    -->
    <p
      v-if="providerLeftThemOutside"
      class="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
      role="status"
      data-test="provider-left-outside"
    >
      {{ providerLeftThemOutside }}
    </p>

    <!--
      The server could not be asked how anybody signs in here.

      Nothing below is drawn in this state: every field and every button
      describes something the server told us about, and guessing produced a
      password form on installations that have no passwords. One sentence, and
      the one thing worth doing about it.
    -->
    <div v-if="statusUnknown" class="space-y-4" data-test="status-unavailable">
      <p class="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100">
        {{ t('auth.login.serverUnreachable') }}
      </p>
      <button
        type="button"
        class="h-12 w-full rounded-xl bg-neutral-100 px-4 font-semibold text-neutral-900 hover:bg-neutral-100/90 active:bg-neutral-100/70 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isAskingAgain"
        data-test="ask-again"
        @click="handleAskAgain"
      >
        {{ isAskingAgain ? $t('common.verifying') : $t('auth.login.askAgain') }}
      </button>
    </div>

    <!--
      And an installation that offers no way in at all, which is a heading over
      an empty box until it says so.
    -->
    <p
      v-if="nothingOnOffer"
      class="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100"
      data-test="no-sign-in-method"
    >
      {{ t('auth.login.noMethod') }}
    </p>

    <!--
      One screen, two steps. The password form is replaced rather than added to:
      what is being asked for now is a code, and leaving the fields that are
      already answered on screen is an invitation to answer them again.
    -->
    <form
      v-if="auth.totpPending"
      class="space-y-5"
      data-test="totp-step"
      @submit.prevent="handleTotpSubmit"
    >
      <p class="text-sm text-white/70">{{ $t('auth.login.totpExplain') }}</p>

      <label class="block">
        <span class="block text-sm font-medium text-white/80">{{ $t('auth.login.totpCode') }}</span>
        <input
          id="login-totp"
          v-model="totpCodeValue"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          autofocus
          :class="inputBaseClasses"
          :placeholder="$t('placeholders.totpCode')"
          :disabled="isSubmittingLogin"
        />
      </label>

      <p v-if="loginError" :class="helperTextClasses">{{ loginError }}</p>

      <button
        type="submit"
        class="h-12 w-full rounded-xl bg-neutral-100 px-4 font-semibold text-neutral-900 hover:bg-neutral-100/90 active:bg-neutral-100/70 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isSubmittingLogin"
      >
        <span v-if="isSubmittingLogin">{{ $t('common.verifying') }}</span>
        <span v-else class="inline-flex items-center gap-2">
          <LockClosedIcon class="h-5 w-5" />
          {{ $t('auth.login.totpSubmit') }}
        </span>
      </button>

      <button
        type="button"
        class="w-full text-xs font-medium text-white/70 underline-offset-4 hover:text-white hover:underline"
        data-test="totp-cancel"
        @click="handleTotpCancel"
      >
        {{ $t('auth.login.totpBack') }}
      </button>
    </form>

    <form v-else-if="supportsLocal" class="space-y-5" @submit.prevent="handleLoginSubmit">
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

    <div v-if="supportsPasskey && !auth.totpPending" class="mt-3">
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

    <div
      v-if="!auth.totpPending && supportsLocal && supportsOidc"
      class="my-4 flex items-center gap-4"
    >
      <div class="h-px w-full bg-white/10"></div>
      <span class="text-xs text-white/50">{{ $t('common.or') }}</span>
      <div class="h-px w-full bg-white/10"></div>
    </div>

    <div v-if="supportsOidc && !auth.totpPending" class="mb-2">
      <button
        class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-700/50 px-4 text-sm font-medium text-white ring-1 ring-inset ring-white/10 enabled:hover:bg-neutral-700/70 enabled:active:bg-neutral-700/90 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        :disabled="Boolean(oidcUnavailableMessage)"
        :aria-describedby="oidcUnavailableMessage ? 'sso-unavailable' : undefined"
        @click="handleOidcLogin"
      >
        <KeyIcon class="h-5 w-5" />
        <span class="truncate">{{ $t('auth.sso.continue') }}</span>
      </button>
      <p v-if="oidcUnavailableMessage" id="sso-unavailable" class="mt-2" :class="helperTextClasses">
        {{ oidcUnavailableMessage }}
      </p>
    </div>

    <!--
      The last word, where there is no form to put it under. Never the status
      error of a server that could not be reached: that one says the browser
      received no response and suggests looking at PUBLIC_URL and CORS, which
      is an accurate description of a fetch that got nowhere and a thoroughly
      misleading explanation of a session that ran out.
    -->
    <p
      v-if="!statusUnknown && !supportsLocal && (loginError || statusError)"
      class="mt-4"
      :class="helperTextClasses"
    >
      {{ loginError || statusError }}
    </p>
  </AuthLayout>
</template>
