<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppSettings } from '@/stores/appSettings';
import { isEditableExtension } from '@/config/editor';
import { calculateExpirationDate } from '@/utils/datetime';
import ModalDialog from '@/components/ModalDialog.vue';
import {
  createShare,
  copyDirectShareFileUrl,
  copyShareUrl,
  DIRECT_SHARE_FILE_MODES,
  getDirectShareFileUrl,
} from '@/api/shares.api';
import { fetchShareableUsers } from '@/api/users.api';
import flatpickr from 'flatpickr';
import 'flatpickr/dist/flatpickr.min.css';
import {
  ShareIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  LockClosedIcon,
  GlobeAltIcon,
  UsersIcon,
  CalendarIcon,
  ChevronDownIcon,
} from '@heroicons/vue/24/outline';

const { t } = useI18n();
const appSettings = useAppSettings();

const props = defineProps({
  modelValue: Boolean,
  item: Object, // {name, path, kind}
});

const emit = defineEmits(['update:modelValue', 'shareCreated']);

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

// Form state
const accessMode = ref('readonly');
const sharingType = ref('anyone');
const password = ref('');
const enablePassword = ref(false);
const selectedUserIds = ref([]);
const expiresAtDate = ref(null);
const enableExpiry = ref(false);
const label = ref('');
const showAdvancedPermissions = ref(false);
const allowDelete = ref(true);
const allowCreateFolder = ref(true);
const allowCreateFile = ref(true);
const allowUpload = ref(true);

// UI state
const isCreating = ref(false);
const error = ref('');
const shareResult = ref(null);
const linkCopied = ref(false);
const directLinkCopied = ref(false);
const directLinkMode = ref('auto');
const availableUsers = ref([]);
const loadingUsers = ref(false);
const expiresAtInputRef = ref(null);
let expiresPicker = null;

// Computed
const isDirectory = computed(() => props.item?.kind === 'directory');
const supportsSharedEditor = computed(
  () => !isDirectory.value && isEditableExtension(props.item?.kind || '')
);
const sourcePath = computed(() => {
  if (!props.item) return '';
  const parentPath = props.item.path || '';
  return parentPath ? `${parentPath}/${props.item.name}` : props.item.name;
});
const directLinkModeOptions = computed(() =>
  DIRECT_SHARE_FILE_MODES.filter(
    (mode) => mode.value !== 'editor' || supportsSharedEditor.value
  ).map((mode) => ({
    ...mode,
    label: t(mode.labelKey, mode.fallback),
  }))
);
const directShareUrl = computed(() => {
  if (!shareResult.value?.shareToken) return '';
  return getDirectShareFileUrl(shareResult.value.shareToken, '', directLinkMode.value);
});

// Reset form when dialog opens/closes
watch(isOpen, async (opened) => {
  if (opened) {
    resetForm();
    if (props.item?.name) {
      label.value = props.item.name;
    }

    // Apply default share expiration if user has one set
    const defaultExpiration = appSettings.userSettings?.defaultShareExpiration;
    const expirationDate = calculateExpirationDate(defaultExpiration);

    if (expirationDate) {
      enableExpiry.value = true;
      expiresAtDate.value = expirationDate;
      await nextTick();
      await initExpiresPicker();
    }
  } else {
    shareResult.value = null;
    enableExpiry.value = false;
    expiresAtDate.value = null;
    destroyExpiresPicker();
  }
});

// Load users when sharing type changes to 'users'
watch(sharingType, async (newType) => {
  if (newType === 'users' && availableUsers.value.length === 0) {
    await loadUsers();
  }
});

function resetForm() {
  accessMode.value = 'readonly';
  sharingType.value = 'anyone';
  password.value = '';
  enablePassword.value = false;
  selectedUserIds.value = [];
  expiresAtDate.value = null;
  enableExpiry.value = false;
  label.value = '';
  showAdvancedPermissions.value = false;
  allowDelete.value = true;
  allowCreateFolder.value = true;
  allowCreateFile.value = true;
  allowUpload.value = true;
  error.value = '';
  shareResult.value = null;
  linkCopied.value = false;
  directLinkCopied.value = false;
  directLinkMode.value = 'auto';
}

function destroyExpiresPicker() {
  if (!expiresPicker) return;
  try {
    expiresPicker.destroy();
  } finally {
    expiresPicker = null;
  }
}

async function initExpiresPicker() {
  await nextTick();
  const el = expiresAtInputRef.value;
  if (!el) return;

  // Destroy existing picker if it exists
  if (expiresPicker) {
    expiresPicker.destroy();
    expiresPicker = null;
  }

  expiresPicker = flatpickr(el, {
    enableTime: true,
    time_24hr: true,
    allowInput: true,
    dateFormat: 'Y-m-d H:i',
    defaultDate: expiresAtDate.value || null,
    onChange: (selectedDates) => {
      expiresAtDate.value = selectedDates?.[0] || null;
    },
  });

  // If we have a default date, set it in the picker
  if (expiresAtDate.value) {
    expiresPicker.setDate(expiresAtDate.value, false);
  }
}

watch(enableExpiry, async (enabled) => {
  if (enabled) {
    await initExpiresPicker();
    return;
  }
  destroyExpiresPicker();
  expiresAtDate.value = null;
});

onBeforeUnmount(() => {
  destroyExpiresPicker();
});

async function loadUsers() {
  try {
    loadingUsers.value = true;
    const response = await fetchShareableUsers();
    availableUsers.value = response.users || [];
  } catch (err) {
    console.error('Failed to load users:', err);
  } finally {
    loadingUsers.value = false;
  }
}

function toggleUserSelection(userId) {
  const index = selectedUserIds.value.indexOf(userId);
  if (index > -1) {
    selectedUserIds.value.splice(index, 1);
  } else {
    selectedUserIds.value.push(userId);
  }
}

async function createShareLink() {
  if (!sourcePath.value) {
    error.value = t(
      'share.errors.invalidSourcePath',
      'Unable to determine the item path to share.'
    );
    return;
  }

  if (sharingType.value === 'users' && selectedUserIds.value.length === 0) {
    error.value = t('share.errors.selectAtLeastOneUser', 'Select at least one user.');
    return;
  }

  if (enableExpiry.value) {
    const date = expiresAtDate.value;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      error.value = t('share.errors.expirationRequired', 'Choose a valid expiration date.');
      return;
    }
    if (date.getTime() <= Date.now()) {
      error.value = t('share.errors.expirationMustBeFuture', 'Expiration must be in the future.');
      return;
    }
  }

  try {
    isCreating.value = true;
    error.value = '';

    const shareData = {
      sourcePath: sourcePath.value,
      accessMode: accessMode.value,
      allowDelete: allowDelete.value,
      allowCreateFolder: allowCreateFolder.value,
      allowCreateFile: allowCreateFile.value,
      allowUpload: allowUpload.value,
      sharingType: sharingType.value,
      password: enablePassword.value ? password.value : null,
      userIds: sharingType.value === 'users' ? selectedUserIds.value : [],
      expiresAt:
        enableExpiry.value && expiresAtDate.value ? expiresAtDate.value.toISOString() : null,
      label: label.value || null,
    };

    const result = await createShare(shareData);
    shareResult.value = result;

    emit('shareCreated', result);
  } catch (err) {
    error.value = err.message || t('share.errors.failedToCreateShare');
  } finally {
    isCreating.value = false;
  }
}

async function copyLink() {
  if (!shareResult.value?.shareToken) return;

  try {
    await copyShareUrl(shareResult.value.shareToken);
    linkCopied.value = true;
    setTimeout(() => {
      linkCopied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy link:', err);
  }
}

async function copyDirectLink() {
  if (!shareResult.value?.shareToken) return;

  try {
    await copyDirectShareFileUrl(shareResult.value.shareToken, '', directLinkMode.value);
    directLinkCopied.value = true;
    setTimeout(() => {
      directLinkCopied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy direct file link:', err);
  }
}

function closeDialog() {
  isOpen.value = false;
}
</script>

<template>
  <ModalDialog v-model="isOpen">
    <template #title>
      <ShareIcon class="w-5 h-5" />
      {{ shareResult ? t('share.shareCreated') : t('share.createShareLink') }}
    </template>

    <!-- Share created success view -->
    <div v-if="shareResult" class="space-y-4">
      <div class="p-4 rounded-lg bg-green-50 dark:bg-green-900/20">
        <div class="flex items-center gap-2 text-green-800 dark:text-green-200">
          <CheckIcon class="w-5 h-5" />
          <span class="font-medium">{{ t('share.shareLinkCreatedSuccess') }}</span>
        </div>
      </div>

      <div>
        <label class="block mb-2 text-sm font-medium">{{ t('share.shareLink') }}</label>
        <div class="flex gap-2">
          <input
            type="text"
            :value="shareResult.shareUrl"
            readonly
            class="flex-1 px-3 py-2 text-sm border rounded-lg bg-gray-50 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            @click="copyLink"
            class="px-4 py-2 text-sm font-medium text-white transition rounded-lg"
            :class="linkCopied ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'"
          >
            <ClipboardDocumentIcon v-if="!linkCopied" class="w-5 h-5" />
            <CheckIcon v-else class="w-5 h-5" />
          </button>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between gap-3 mb-2">
          <label class="block text-sm font-medium">
            {{
              shareResult.isDirectory
                ? t('share.directFolderLink', 'Direct folder ZIP link')
                : t('share.directFileLink', 'Direct file link')
            }}
          </label>
          <select
            v-model="directLinkMode"
            class="px-2 py-1 text-xs border rounded-md bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            :title="t('share.directLinkMode', 'Direct link mode')"
          >
            <option v-for="mode in directLinkModeOptions" :key="mode.value" :value="mode.value">
              {{ mode.label }}
            </option>
          </select>
        </div>
        <div class="flex gap-2">
          <input
            type="text"
            :value="directShareUrl"
            readonly
            class="flex-1 px-3 py-2 text-sm border rounded-lg bg-gray-50 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            @click="copyDirectLink"
            class="px-4 py-2 text-sm font-medium text-white transition rounded-lg"
            :class="directLinkCopied ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'"
          >
            <ClipboardDocumentIcon v-if="!directLinkCopied" class="w-5 h-5" />
            <CheckIcon v-else class="w-5 h-5" />
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-gray-500 dark:text-gray-400">{{ t('share.access') }}</span>
          <span class="ml-2 font-medium">{{
            shareResult.accessMode === 'readonly'
              ? t('settings.access.readOnly')
              : t('settings.access.readWrite')
          }}</span>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">{{ t('share.type') }}</span>
          <span class="ml-2 font-medium">{{
            shareResult.sharingType === 'anyone'
              ? t('share.anyoneWithLink')
              : t('share.specificUsers')
          }}</span>
        </div>
        <div v-if="shareResult.hasPassword">
          <span class="text-gray-500 dark:text-gray-400">{{ t('share.password') }}</span>
          <span class="ml-2 font-medium text-green-600">{{ t('share.protected') }}</span>
        </div>
        <div v-if="shareResult.expiresAt">
          <span class="text-gray-500 dark:text-gray-400">{{ t('share.expires') }}</span>
          <span class="ml-2 font-medium">{{
            new Date(shareResult.expiresAt).toLocaleDateString()
          }}</span>
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-4">
        <button
          @click="closeDialog"
          class="px-4 py-2 text-sm font-medium transition border rounded-lg border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          {{ t('common.done') }}
        </button>
      </div>
    </div>

    <!-- Share creation form -->
    <div v-else class="space-y-4">
      <div
        v-if="error"
        class="p-3 text-sm text-red-700 rounded-lg bg-red-50 dark:bg-red-900/20 dark:text-red-200"
      >
        {{ error }}
      </div>

      <!-- Source info -->
      <div class="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800">
        <div class="text-sm text-gray-500 dark:text-gray-400">
          {{ t('share.sharing') }}
        </div>
        <div class="font-medium">{{ item?.name }}</div>
        <div class="text-xs text-gray-500">{{ sourcePath }}</div>
      </div>

      <!-- Label -->
      <div>
        <label class="block mb-2 text-sm font-medium">{{ t('share.label') }}</label>
        <input
          v-model="label"
          type="text"
          :placeholder="t('share.labelPlaceholder')"
          class="w-full px-3 py-2 text-sm border rounded-lg border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Access Mode -->
      <div>
        <label class="block mb-2 text-sm font-medium">{{ t('share.accessMode') }}</label>
        <div class="grid grid-cols-2 gap-2">
          <button
            @click="accessMode = 'readonly'"
            class="px-4 py-2 text-sm font-medium transition border rounded-lg"
            :class="
              accessMode === 'readonly'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            "
          >
            {{ t('settings.access.readOnly') }}
          </button>
          <button
            @click="accessMode = 'readwrite'"
            class="px-4 py-2 text-sm font-medium transition border rounded-lg"
            :class="
              accessMode === 'readwrite'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            "
          >
            {{ t('settings.access.readWrite') }}
          </button>
        </div>
      </div>

      <div
        v-if="isDirectory && accessMode === 'readwrite'"
        class="rounded-lg border border-zinc-200 dark:border-zinc-700"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
          :aria-expanded="showAdvancedPermissions"
          @click="showAdvancedPermissions = !showAdvancedPermissions"
        >
          {{ t('share.advancedPermissions', 'Advanced') }}
          <ChevronDownIcon
            class="h-4 w-4 transition-transform"
            :class="showAdvancedPermissions ? 'rotate-180' : ''"
          />
        </button>
        <div
          v-if="showAdvancedPermissions"
          class="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-700"
        >
          <label class="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>{{ t('share.allowDelete', 'Allow deleting files') }}</span>
            <input
              v-model="allowDelete"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
          <label class="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>{{ t('share.allowCreateFolder', 'Allow creating folders') }}</span>
            <input
              v-model="allowCreateFolder"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
          <label class="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>{{ t('share.allowCreateFile', 'Allow creating files') }}</span>
            <input
              v-model="allowCreateFile"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
          <label class="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>{{ t('share.allowUpload', 'Allow uploading files and folders') }}</span>
            <input
              v-model="allowUpload"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
        </div>
      </div>

      <!-- Sharing Type -->
      <div>
        <label class="block mb-2 text-sm font-medium">{{ t('share.whoCanAccess') }}</label>
        <div class="grid grid-cols-2 gap-2">
          <button
            @click="sharingType = 'anyone'"
            class="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition border rounded-lg"
            :class="
              sharingType === 'anyone'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            "
          >
            <GlobeAltIcon class="w-4 h-4" />
            {{ t('share.anyoneWithLink') }}
          </button>
          <button
            @click="sharingType = 'users'"
            class="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition border rounded-lg"
            :class="
              sharingType === 'users'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            "
          >
            <UsersIcon class="w-4 h-4" />
            {{ t('share.specificUsers') }}
          </button>
        </div>
      </div>

      <!-- User Selection (if sharing type is 'users') -->
      <div
        v-if="sharingType === 'users'"
        class="p-3 border rounded-lg border-zinc-300 dark:border-zinc-700"
      >
        <div class="mb-2 text-sm font-medium">{{ t('share.selectUsers') }}</div>
        <div v-if="loadingUsers" class="text-sm text-gray-500">
          {{ t('share.loadingUsers') }}
        </div>
        <div v-else-if="availableUsers.length === 0" class="text-sm text-gray-500">
          {{ t('share.noUsersAvailable') }}
        </div>
        <div v-else class="space-y-2 max-h-40 overflow-y-auto">
          <label
            v-for="user in availableUsers"
            :key="user.id"
            class="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <input
              type="checkbox"
              :checked="selectedUserIds.includes(user.id)"
              @change="toggleUserSelection(user.id)"
              class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span class="text-sm">{{ user.displayName || user.email }}</span>
            <span class="text-xs text-gray-500">{{ user.email }}</span>
          </label>
        </div>
      </div>

      <!-- Password Protection (only for 'anyone' shares) -->
      <div v-if="sharingType === 'anyone'">
        <label class="flex items-center gap-2 mb-2 cursor-pointer">
          <input
            v-model="enablePassword"
            type="checkbox"
            class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <LockClosedIcon class="w-4 h-4" />
          <span class="text-sm font-medium">{{ t('share.passwordProtect') }}</span>
        </label>
        <input
          v-if="enablePassword"
          v-model="password"
          type="password"
          :placeholder="t('share.enterPassword')"
          class="w-full px-3 py-2 text-sm border rounded-lg border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Expiration -->
      <div>
        <label class="flex items-center gap-2 mb-2 cursor-pointer">
          <input
            v-model="enableExpiry"
            type="checkbox"
            class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <CalendarIcon class="w-4 h-4" />
          <span class="text-sm font-medium">{{ t('share.setExpirationDate') }}</span>
        </label>
        <input
          v-if="enableExpiry"
          ref="expiresAtInputRef"
          type="text"
          autocomplete="off"
          :placeholder="t('share.expirationPlaceholder', 'YYYY-MM-DD HH:MM')"
          class="w-full px-3 py-2 text-sm border rounded-lg border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Actions -->
      <div class="flex justify-end gap-2 pt-4">
        <button
          @click="closeDialog"
          :disabled="isCreating"
          class="px-4 py-2 text-sm font-medium transition border rounded-lg border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          @click="createShareLink"
          :disabled="isCreating"
          class="px-4 py-2 text-sm font-medium text-white transition bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {{ isCreating ? t('share.creating') : t('share.createShareLink') }}
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style>
.dark .flatpickr-calendar {
  background: rgb(24 24 27 / 0.98);
  border-color: rgb(63 63 70);
  box-shadow:
    0 20px 25px -5px rgb(0 0 0 / 0.4),
    0 10px 10px -5px rgb(0 0 0 / 0.25);
}
.dark .flatpickr-months .flatpickr-month,
.dark .flatpickr-current-month,
.dark .flatpickr-weekday,
.dark .flatpickr-time input,
.dark .flatpickr-time .flatpickr-am-pm,
.dark .flatpickr-day {
  color: rgb(228 228 231);
}
.dark .flatpickr-day:hover,
.dark .flatpickr-day:focus {
  background: rgb(39 39 42);
  border-color: rgb(39 39 42);
}
.dark .flatpickr-day.selected,
.dark .flatpickr-day.startRange,
.dark .flatpickr-day.endRange,
.dark .flatpickr-day.selected:hover,
.dark .flatpickr-day.startRange:hover,
.dark .flatpickr-day.endRange:hover {
  background: rgb(37 99 235);
  border-color: rgb(37 99 235);
}
.dark .flatpickr-time input,
.dark .flatpickr-time .flatpickr-am-pm {
  background: transparent;
}
</style>
