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

// Deliberately not based on layout (offsetParent): that is untestable outside
// a real browser. The checks below are the ones jsdom can answer honestly —
// the selector already excludes [disabled], so only hidden markup is left.
const focusableElements = () =>
  Array.from(dialogRef.value?.querySelectorAll(FOCUSABLE) || []).filter(
    (el) => !el.hidden && !el.closest('[aria-hidden="true"],[hidden]')
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

  // Wrap on position, not on identity: if focus sits on something the filter
  // above rejected (or on the dialog itself), comparing against first/last
  // would never match and Tab would walk out of the dialog.
  const index = elements.indexOf(document.activeElement);
  const last = elements.length - 1;
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    elements[last].focus();
  } else if (!event.shiftKey && (index === -1 || index === last)) {
    event.preventDefault();
    elements[0].focus();
  }
};

watch(
  popupOpened,
  async (opened) => {
    if (opened) {
      previouslyFocused = document.activeElement;
      await nextTick();
      // A dialog that focuses its own field (the archive password prompt, for
      // one) runs its watcher before this one. Do not steal that focus: only
      // place it when nothing inside the dialog holds it yet.
      if (dialogRef.value?.contains(document.activeElement)) return;
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
