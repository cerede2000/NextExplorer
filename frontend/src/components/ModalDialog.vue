<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { XMarkIcon } from '@heroicons/vue/20/solid';

const props = defineProps({
  modelValue: Boolean,
  /**
   * Raise the dialog above a full-screen overlay.
   *
   * The dialog teleports to the body, so it stacks against the page rather
   * than against whatever opened it. That is fine everywhere except above the
   * preview overlay, which sits far higher than a dialog's usual level and
   * would otherwise cover it completely.
   */
  elevated: Boolean,
  /**
   * A dialog that shows a listing rather than a question.
   *
   * The ordinary width is meant for a sentence and two buttons; something with
   * names, sizes and dates in it needs room, and cramming it into 500 pixels
   * is how a panel ends up scrolling sideways.
   */
  wide: Boolean,
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
    <!--
      The padding is what keeps a dialog off the edges of the screen, and the
      width is a ceiling rather than a size: at 500 pixels flat, a phone in
      portrait had a dialog wider than itself and scrolled sideways to reach
      the buttons.
    -->
    <div
      @click="onBackgroundClick"
      class="fixed inset-0 flex items-center justify-center bg-zinc-700/50 p-4 backdrop-blur-xs max-sm:items-end max-sm:p-0 dark:bg-neutral-700/50"
      :class="elevated ? 'z-2200' : 'z-50'"
    >
      <!--
        A column with a ceiling on its height, so the heading and whatever the
        dialog puts at the bottom stay where they are and the middle scrolls.
        Without it a long list simply grew: the title went off the top of the
        screen, the buttons off the bottom, and neither could be reached.
      -->
      <div
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @click.stop
        @keydown="onKeydown"
        class="flex max-h-[85vh] w-full flex-col rounded-xl border border-zinc-400 bg-white text-gray-800 shadow-lg transition-all duration-300 max-sm:rounded-b-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-neutral-300"
        :class="wide ? 'sm:w-[54rem]' : 'sm:w-[500px]'"
      >
        <div class="flex shrink-0 justify-between p-6">
          <h2 :id="titleId" class="flex min-w-0 items-center gap-2 text-lg font-bold">
            <slot name="title"> Modal </slot>
          </h2>
          <button
            type="button"
            class="shrink-0"
            :aria-label="t('common.close')"
            @click="popupOpened = false"
          >
            <XMarkIcon class="h-6" />
          </button>
        </div>
        <hr class="h-px shrink-0 border-0 bg-zinc-300 dark:bg-zinc-800" />

        <div class="min-h-0 flex-1 overflow-y-auto p-6 py-6 text-sm">
          <slot> </slot>
        </div>

        <!--
          What a dialog asks for stays where it can be reached. Inside the
          scrolling part, a long list pushed the buttons below the fold, on a
          window that could not grow: the answer to a question was off the
          screen, and the only way back was Escape.
        -->
        <div
          v-if="$slots.footer"
          class="shrink-0 border-t border-zinc-300 px-6 py-4 text-sm dark:border-zinc-800"
        >
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
