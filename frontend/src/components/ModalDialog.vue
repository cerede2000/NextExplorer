<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { XMarkIcon } from '@heroicons/vue/20/solid';

const props = defineProps({
  modelValue: Boolean,
});

const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

const popupOpened = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

// Ties the dialog to its own heading, so assistive technology announces what
// the dialog is about instead of an anonymous "dialog".
const titleId = `modal-title-${useId()}`;
const dialogRef = ref(null);
let previouslyFocused = null;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusableElements = () =>
  Array.from(dialogRef.value?.querySelectorAll(FOCUSABLE) || []).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );

/**
 * Keep the keyboard inside the dialog while it is open.
 *
 * Without this, Tab walks straight into the page behind the overlay, which is
 * both invisible and inert to the pointer — a keyboard user ends up lost.
 */
const onKeydown = (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    popupOpened.value = false;
    return;
  }
  if (event.key !== 'Tab') return;

  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    return;
  }

  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

watch(
  popupOpened,
  async (opened) => {
    if (opened) {
      previouslyFocused = document.activeElement;
      await nextTick();
      const [firstFocusable] = focusableElements();
      (firstFocusable || dialogRef.value)?.focus();
      return;
    }
    // Send focus back where it came from, so closing does not drop the user
    // at the top of the document.
    previouslyFocused?.focus?.();
    previouslyFocused = null;
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  previouslyFocused = null;
});

function onBackgroundClick() {
  if (popupOpened.value) {
    popupOpened.value = false;
  }
}
</script>
<template>
  <Teleport to="body" v-if="popupOpened">
    <div
      @click="onBackgroundClick"
      class="fixed top-0 z-50 flex items-center justify-center w-full h-full max-sm:items-end bg-zinc-700/50 dark:bg-neutral-700/50 backdrop-blur-xs"
    >
      <div
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @click.stop
        @keydown="onKeydown"
        class="rounded-xl w-[500px] shadow-lg text-gray-800 dark:text-neutral-300 bg-white dark:bg-zinc-900 border border-zinc-400 dark:border-zinc-700 transition-all duration-300"
      >
        <div class="flex justify-between p-6">
          <h2 :id="titleId" class="flex items-center gap-2 text-lg font-bold">
            <slot name="title"> Modal </slot>
          </h2>
          <button type="button" :aria-label="t('common.close')" @click="popupOpened = false">
            <XMarkIcon class="h-6" />
          </button>
        </div>
        <hr class="h-px border-0 bg-zinc-300 dark:bg-zinc-800" />

        <div class="p-6 py-6 text-sm">
          <slot> </slot>
        </div>
      </div>
    </div>
  </Teleport>
</template>
