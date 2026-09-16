<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import {
  fetchTwoFactorStatus,
  startTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  replaceRecoveryCodes,
  disableTwoFactor,
} from '@/api';
import { useAuthStore } from '@/stores/auth';

/**
 * A second factor on this account.
 *
 * Three things happen here and each one is a step somebody can stop in the
 * middle of: a secret shown as a square to scan, a code that proves the phone
 * kept it, and ten codes on paper for the day the phone is gone. Nothing is on
 * until the second step, and the third is readable exactly once.
 */

const auth = useAuthStore();
const { t } = useI18n();

const isLocalUser = computed(() => auth.currentUser?.provider === 'local');

const status = ref({ enabled: false, pending: false, recoveryCodesLeft: 0 });
const busy = ref(false);
const errorMsg = ref('');
const successMsg = ref('');

/** The secret being set up, held only while this page is open. */
const secret = ref('');
const uri = ref('');
const codeValue = ref('');

/** Shown once, on the screen that created them. */
const recoveryCodes = ref([]);

const passwordValue = ref('');

const refresh = async () => {
  status.value = await fetchTwoFactorStatus();
};

onMounted(async () => {
  if (!isLocalUser.value) return;
  try {
    await refresh();
  } catch (error) {
    errorMsg.value = error?.message || t('settings.twoFactor.loadFailed');
  }
});

/**
 * The QR code as elements rather than as a string of markup.
 *
 * `qrcode-generator` will hand over an `<svg>` tag, which would have to be
 * written into the page as HTML. Drawing the squares it worked out is the same
 * picture with nothing parsed, and it is a few hundred rectangles.
 *
 * Loaded when there is something to draw, not when the application starts:
 * forty kilobytes for a square almost nobody looks at on any given day has no
 * business in the bundle every page waits for.
 */
const qrModules = ref({ count: 0, cells: [] });

watch(uri, async (value) => {
  if (!value) {
    qrModules.value = { count: 0, cells: [] };
    return;
  }

  const { default: qrcode } = await import('qrcode-generator');
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();

  const count = code.getModuleCount();
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) cells.push({ x: column, y: row });
    }
  }
  // The secret may have been put away while the module was arriving.
  if (uri.value === value) qrModules.value = { count, cells };
});

/** Read off a screen in groups, which is how it is typed into a phone. */
const secretInGroups = computed(() => (secret.value.match(/.{1,4}/g) || []).join(' '));

/**
 * What the server refused, said in the reader's language where we know it.
 *
 * The codes are the two refusals this screen causes on purpose — a code that
 * is not right, and a password that is not — so those two never arrive as the
 * server's own English sentence.
 */
const KNOWN_REFUSALS = {
  AUTH_INVALID_TOTP_CODE: 'settings.twoFactor.confirmFailed',
  AUTH_PASSWORD_INCORRECT: 'settings.twoFactor.wrongPassword',
};

const run = async (task, failure) => {
  errorMsg.value = '';
  successMsg.value = '';
  busy.value = true;
  try {
    await task();
  } catch (error) {
    const known = KNOWN_REFUSALS[error?.code];
    errorMsg.value = known ? t(known) : error?.message || t(failure);
  } finally {
    busy.value = false;
  }
};

const begin = () =>
  run(async () => {
    recoveryCodes.value = [];
    const started = await startTwoFactorEnrolment();
    secret.value = started.secret;
    uri.value = started.uri;
    codeValue.value = '';
    await refresh();
  }, 'settings.twoFactor.startFailed');

const confirm = () =>
  run(async () => {
    const confirmed = await confirmTwoFactorEnrolment(codeValue.value.trim());
    recoveryCodes.value = confirmed.recoveryCodes || [];
    secret.value = '';
    uri.value = '';
    codeValue.value = '';
    successMsg.value = t('settings.twoFactor.turnedOn');
    await refresh();
  }, 'settings.twoFactor.confirmFailed');

const drawNewCodes = () =>
  run(async () => {
    const fresh = await replaceRecoveryCodes(passwordValue.value);
    recoveryCodes.value = fresh.recoveryCodes || [];
    passwordValue.value = '';
    successMsg.value = t('settings.twoFactor.newCodes');
    await refresh();
  }, 'settings.twoFactor.codesFailed');

const turnOff = () =>
  run(async () => {
    await disableTwoFactor(passwordValue.value);
    passwordValue.value = '';
    recoveryCodes.value = [];
    successMsg.value = t('settings.twoFactor.turnedOff');
    await refresh();
  }, 'settings.twoFactor.disableFailed');

/** Somewhere to keep them that is not this screen. */
const copyCodes = async () => {
  try {
    await navigator.clipboard?.writeText(recoveryCodes.value.join('\n'));
    successMsg.value = t('settings.twoFactor.copied');
  } catch {
    // A browser that refuses the clipboard leaves the codes on screen to read.
  }
};

const fieldClasses =
  'block w-full rounded-md border border-zinc-300 bg-white p-2 text-zinc-900 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100';
const buttonClasses =
  'inline-flex justify-center rounded-md border border-transparent bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-hidden disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200';
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.twoFactor.title') }}
      </h2>
      <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {{ isLocalUser ? t('settings.twoFactor.intro') : t('settings.twoFactor.notLocalUser') }}
      </p>
    </div>

    <div
      v-if="isLocalUser"
      class="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="max-w-md space-y-6">
        <p
          v-if="errorMsg"
          class="rounded-md bg-red-100 p-4 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
          data-test="two-factor-error"
        >
          {{ errorMsg }}
        </p>
        <p
          v-if="successMsg"
          class="rounded-md bg-green-100 p-4 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400"
          data-test="two-factor-success"
        >
          {{ successMsg }}
        </p>

        <!-- What the codes are worth, said where they are shown. -->
        <div
          v-if="recoveryCodes.length"
          class="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20"
          data-test="recovery-codes"
        >
          <p class="text-sm font-medium text-amber-900 dark:text-amber-200">
            {{ t('settings.twoFactor.codesTitle') }}
          </p>
          <p class="text-xs text-amber-800 dark:text-amber-300">
            {{ t('settings.twoFactor.codesExplain') }}
          </p>
          <ul class="grid grid-cols-2 gap-1 font-mono text-sm text-amber-900 dark:text-amber-100">
            <li v-for="code in recoveryCodes" :key="code">{{ code }}</li>
          </ul>
          <button type="button" :class="buttonClasses" @click="copyCodes">
            {{ t('settings.twoFactor.copyCodes') }}
          </button>
        </div>

        <!-- Off, and not being set up: the one button that starts it. -->
        <template v-if="!status.enabled && !uri">
          <p class="text-sm text-zinc-600 dark:text-zinc-300" data-test="two-factor-off">
            {{ t('settings.twoFactor.off') }}
          </p>
          <button type="button" :class="buttonClasses" :disabled="busy" @click="begin">
            {{ t('settings.twoFactor.turnOn') }}
          </button>
        </template>

        <!-- Being set up: the square to scan, the secret to type, the code. -->
        <template v-else-if="!status.enabled">
          <div class="space-y-3" data-test="two-factor-setup">
            <p class="text-sm text-zinc-600 dark:text-zinc-300">
              {{ t('settings.twoFactor.scan') }}
            </p>
            <svg
              :viewBox="`0 0 ${qrModules.count} ${qrModules.count}`"
              class="h-48 w-48 rounded bg-white p-2"
              role="img"
              :aria-label="t('settings.twoFactor.qrLabel')"
              data-test="two-factor-qr"
            >
              <rect
                v-for="cell in qrModules.cells"
                :key="`${cell.x}-${cell.y}`"
                :x="cell.x"
                :y="cell.y"
                width="1"
                height="1"
                fill="#18181b"
              />
            </svg>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">
              {{ t('settings.twoFactor.orType') }}
            </p>
            <p
              class="rounded bg-zinc-100 p-2 font-mono text-sm break-all text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
              data-test="two-factor-secret"
            >
              {{ secretInGroups }}
            </p>
          </div>

          <form class="space-y-3" @submit.prevent="confirm">
            <label class="block">
              <span class="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {{ t('settings.twoFactor.codeLabel') }}
              </span>
              <input
                v-model="codeValue"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                :class="fieldClasses"
                :placeholder="t('placeholders.totpCode')"
              />
            </label>
            <button type="submit" :class="buttonClasses" :disabled="busy">
              {{ t('settings.twoFactor.confirm') }}
            </button>
          </form>
        </template>

        <!-- On: how many codes are left, new ones, and the way off. -->
        <template v-else>
          <p class="text-sm text-zinc-600 dark:text-zinc-300" data-test="two-factor-on">
            {{ t('settings.twoFactor.on') }}
          </p>
          <p class="text-sm text-zinc-500 dark:text-zinc-400" data-test="codes-left">
            {{ t('settings.twoFactor.codesLeft', status.recoveryCodesLeft) }}
          </p>

          <form class="space-y-3" @submit.prevent>
            <label class="block">
              <span class="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {{ t('settings.twoFactor.confirmPassword') }}
              </span>
              <input
                v-model="passwordValue"
                type="password"
                autocomplete="current-password"
                :class="fieldClasses"
                :placeholder="t('placeholders.password')"
              />
            </label>
            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                :class="buttonClasses"
                :disabled="busy"
                data-test="draw-new-codes"
                @click="drawNewCodes"
              >
                {{ t('settings.twoFactor.newCodesButton') }}
              </button>
              <button
                type="button"
                class="inline-flex justify-center rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                :disabled="busy"
                data-test="turn-off"
                @click="turnOff"
              >
                {{ t('settings.twoFactor.turnOff') }}
              </button>
            </div>
          </form>
        </template>
      </div>
    </div>
  </div>
</template>
