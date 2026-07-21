<script setup>
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalDialog from '@/components/ModalDialog.vue';

const props = defineProps({
  modelValue: Boolean,
  busy: Boolean,
  invalidPassword: Boolean,
});

const emit = defineEmits(['update:modelValue', 'submit']);
const { t } = useI18n();
const password = ref('');
const passwordInput = ref(null);

watch(
  () => props.modelValue,
  async (opened) => {
    if (!opened) {
      password.value = '';
      return;
    }
    await nextTick();
    passwordInput.value?.focus();
  }
);

const close = () => {
  if (!props.busy) emit('update:modelValue', false);
};

const submit = () => emit('submit', password.value);
</script>

<template>
  <ModalDialog :model-value="modelValue" @update:model-value="close">
    <template #title>{{ t('archive.password.title') }}</template>
    <form @submit.prevent="submit">
      <p class="mb-5 text-base text-zinc-700 dark:text-zinc-200">
        {{ t('archive.password.description') }}
      </p>
      <label class="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200" for="archive-password">
        {{ t('archive.password.label') }}
      </label>
      <input
        id="archive-password"
        ref="passwordInput"
        v-model="password"
        type="password"
        autocomplete="current-password"
        class="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        :disabled="busy"
      />
      <p v-if="invalidPassword" class="mt-2 text-sm text-red-600 dark:text-red-400">
        {{ t('archive.password.invalid') }}
      </p>
      <div class="mt-6 flex justify-end gap-3">
        <button
          type="button"
          class="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
          :disabled="busy"
          @click="close"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="submit"
          class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
          :disabled="busy"
        >
          {{ busy ? t('archive.password.extracting') : t('archive.password.submit') }}
        </button>
      </div>
    </form>
  </ModalDialog>
</template>
