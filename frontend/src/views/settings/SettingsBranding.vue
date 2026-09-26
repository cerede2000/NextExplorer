<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';
import { XMarkIcon } from '@heroicons/vue/24/solid';

const appSettings = useAppSettings();
const { t } = useI18n();

const DEFAULT_LOGO_URL = '/logo.svg';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg'];

const local = reactive({
  appName: 'Explorer',
  logoUrl: DEFAULT_LOGO_URL,
  showPoweredBy: false,
});

/**
 * A logo chosen and not saved yet: the file, and an address only this browser
 * can show it at. Nothing is sent when it is chosen.
 *
 * It used to be uploaded at once, over the logo in use and under the one name
 * its type had: Discard could not bring the old logo back, and a PNG chosen
 * over a PNG came back at the same address, so there was nothing to save.
 */
const pendingLogo = ref(null);

const forgetPendingLogo = () => {
  if (pendingLogo.value) URL.revokeObjectURL(pendingLogo.value.previewUrl);
  pendingLogo.value = null;
};

const logoPreviewUrl = computed(() => pendingLogo.value?.previewUrl ?? local.logoUrl);
const showsDefaultLogo = computed(() => !pendingLogo.value && local.logoUrl === DEFAULT_LOGO_URL);

const saving = ref(false);
const uploadMessage = ref('');
const uploadMessageType = ref(''); // 'success' or 'error'
const fileInputRef = ref(null);

const original = computed(() => appSettings.state.branding);
const dirty = computed(
  () =>
    local.appName !== original.value.appName ||
    local.logoUrl !== original.value.appLogoUrl ||
    local.showPoweredBy !== original.value.showPoweredBy ||
    pendingLogo.value !== null
);

// A name of spaces is no name: the header and the sign-in page showed nothing.
const nameMissing = computed(() => String(local.appName ?? '').trim() === '');

const reset = () => {
  const b = appSettings.state.branding;
  local.appName = b.appName;
  local.logoUrl = b.appLogoUrl;
  local.showPoweredBy = b.showPoweredBy || false;
  forgetPendingLogo();
};

watch(() => appSettings.state.branding, reset, { immediate: true });

onBeforeUnmount(forgetPendingLogo);

const clearMessageLater = () => {
  setTimeout(() => {
    uploadMessage.value = '';
    uploadMessageType.value = '';
  }, 3000);
};

const save = async () => {
  if (nameMissing.value || saving.value) return;
  saving.value = true;
  try {
    if (pendingLogo.value) {
      // One request for the logo and the rest: stored together, or not at all.
      await appSettings.saveLogo(pendingLogo.value.file, {
        appName: local.appName,
        showPoweredBy: local.showPoweredBy,
      });
    } else {
      await appSettings.save({
        branding: {
          appName: local.appName,
          appLogoUrl: local.logoUrl,
          showPoweredBy: local.showPoweredBy,
        },
      });
    }
    uploadMessage.value = t('settings.branding.saved');
    uploadMessageType.value = 'success';
    clearMessageLater();
  } catch (error) {
    uploadMessage.value = t('settings.branding.saveFailed', { reason: error.message });
    uploadMessageType.value = 'error';
  } finally {
    saving.value = false;
  }
};

const handleLogoSelect = (event) => {
  const file = event.target.files?.[0];
  // Emptied at once, so that choosing the same file again is still a change.
  if (fileInputRef.value) fileInputRef.value.value = '';
  if (!file) return;

  if (file.size > MAX_LOGO_BYTES) {
    uploadMessage.value = t('settings.branding.logoError');
    uploadMessageType.value = 'error';
    return;
  }

  if (!LOGO_TYPES.includes(file.type)) {
    uploadMessage.value = t('settings.branding.invalidFileType');
    uploadMessageType.value = 'error';
    return;
  }

  forgetPendingLogo();
  pendingLogo.value = { file, previewUrl: URL.createObjectURL(file) };
  uploadMessage.value = t('settings.branding.logoSelected');
  uploadMessageType.value = 'success';
  clearMessageLater();
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const useDefaultLogo = () => {
  forgetPendingLogo();
  local.logoUrl = DEFAULT_LOGO_URL;
  uploadMessage.value = t('settings.branding.defaultLogoSelected');
  uploadMessageType.value = 'success';
  clearMessageLater();
};
</script>

<template>
  <div class="space-y-6">
    <!-- Upload Message Alert -->
    <div
      v-if="uploadMessage"
      :class="[
        'rounded-md border p-4 text-sm',
        uploadMessageType === 'success'
          ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-400/30 dark:border-green-400/20'
          : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-400/30 dark:border-red-400/20',
      ]"
    >
      {{ uploadMessage }}
    </div>

    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <div class="text-sm">{{ t('common.unsavedChanges') }}</div>
      <div class="flex gap-2">
        <button
          type="button"
          data-test="branding-save"
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400 disabled:opacity-50"
          :disabled="nameMissing || saving"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
        <button
          type="button"
          class="rounded-md border border-white/10 px-3 py-1 hover:bg-white/10 disabled:opacity-50"
          :disabled="saving"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <!-- Header -->
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('titles.branding') }}
      </h2>
      <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
        {{ t('settings.branding.subtitle') }}
      </p>
    </div>

    <!-- Content -->
    <div
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6"
    >
      <div class="space-y-6">
        <div class="grid gap-6 md:grid-cols-2">
          <!-- Logo (left) -->
          <div>
            <div class="mb-3">
              <label class="block font-medium text-zinc-900 dark:text-zinc-100 mb-1">
                {{ t('settings.branding.logo') }}
              </label>
              <p class="text-sm text-zinc-500 dark:text-zinc-400">
                {{ t('settings.branding.logoHelp') }}
              </p>
            </div>

            <input
              ref="fileInputRef"
              type="file"
              accept=".svg,.png,.jpg,.jpeg"
              style="display: none"
              @change="handleLogoSelect"
            />

            <div class="max-w-sm">
              <div
                class="group relative flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-700 dark:bg-zinc-900/50"
              >
                <img
                  :src="logoPreviewUrl"
                  :alt="t('common.logoAlt', { name: local.appName })"
                  class="h-24 w-auto max-w-full"
                />
                <button
                  v-if="!showsDefaultLogo"
                  type="button"
                  :title="t('common.remove')"
                  class="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-zinc-700 shadow-sm opacity-0 transition hover:bg-white hover:text-zinc-900 focus:opacity-100 dark:bg-zinc-800/90 dark:text-zinc-200 group-hover:opacity-100"
                  @click="useDefaultLogo"
                >
                  <XMarkIcon class="h-4 w-4" />
                </button>
              </div>

              <div class="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  data-test="branding-choose-logo"
                  :disabled="saving"
                  class="w-full inline-flex justify-center rounded-md border border-transparent bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-zinc-800 focus:outline-hidden focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  @click="triggerFileInput"
                >
                  {{
                    showsDefaultLogo
                      ? t('settings.branding.chooseLogo')
                      : t('settings.branding.chooseAnotherLogo')
                  }}
                </button>

                <button
                  v-if="!showsDefaultLogo"
                  type="button"
                  class="w-full rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-xs hover:bg-zinc-50 focus:outline-hidden focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 md:hidden"
                  @click="useDefaultLogo"
                >
                  {{ t('common.remove') }}
                </button>
              </div>
            </div>
          </div>

          <!-- App Name (right) -->
          <div>
            <div class="mb-3">
              <label class="block font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {{ t('settings.branding.appName') }}
              </label>
              <p class="text-sm text-zinc-500 dark:text-zinc-400">
                {{ t('settings.branding.appNameHelp') }}
              </p>
            </div>
            <input
              v-model="local.appName"
              type="text"
              maxlength="100"
              placeholder="Explorer"
              class="block w-full rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border"
            />
            <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {{ local.appName.length }}/100
            </p>
            <p
              v-if="nameMissing"
              data-test="branding-name-invalid"
              class="mt-1 text-sm text-red-600"
            >
              {{ t('settings.branding.appNameRequired') }}
            </p>
          </div>
        </div>

        <!-- Preview -->
        <div
          class="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/50"
        >
          <p class="mb-3 font-medium text-zinc-600 dark:text-zinc-300">
            {{ t('settings.branding.preview') }}
          </p>
          <div class="flex items-center gap-3">
            <img
              :src="logoPreviewUrl"
              :alt="t('common.logoAlt', { name: local.appName })"
              class="h-10 w-auto"
              @error="$event.target.style.display = 'none'"
            />
            <span class="text-lg font-bold text-zinc-900 dark:text-zinc-100">{{
              local.appName
            }}</span>
          </div>
        </div>
        <div>
          <label class="flex items-start gap-3 cursor-pointer">
            <div class="flex h-5 items-center pt-0.5">
              <input
                v-model="local.showPoweredBy"
                type="checkbox"
                class="h-4 w-4 rounded-sm border-zinc-300 text-zinc-600 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800"
              />
            </div>
            <div>
              <span class="font-medium text-zinc-700 dark:text-zinc-300">
                {{ t('settings.branding.showPoweredBy') }}
              </span>
              <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {{ t('settings.branding.showPoweredByHelp') }}
              </p>
            </div>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>
