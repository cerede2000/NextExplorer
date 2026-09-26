<script setup>
import { computed, defineProps, defineEmits } from 'vue';

import { XMarkIcon } from '@heroicons/vue/20/solid';

const props = defineProps({
  modelValue: Boolean,
  /**
   * Raise the dialog above a full-screen overlay.
   *
   * The dialog teleports to the body, so it stacks against the page rather than
   * against whatever opened it. That is fine everywhere except above a panel
   * that dims the page behind it, which sits far higher than a dialog's usual
   * level and would otherwise cover the dialog's own buttons.
   */
  elevated: Boolean,
});

const emit = defineEmits(['update:modelValue']);

const popupOpened = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
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
      :class="props.elevated ? 'z-2200' : 'z-50'"
      class="fixed top-0 flex items-center justify-center w-full h-full max-sm:items-end bg-zinc-700/50 dark:bg-neutral-700/50 backdrop-blur-xs"
    >
      <div
        @click.stop
        class="rounded-xl w-[500px] shadow-lg text-gray-800 dark:text-neutral-300 bg-white dark:bg-zinc-900 border border-zinc-400 dark:border-zinc-700 transition-all duration-300"
      >
        <div class="flex justify-between p-6">
          <h2 class="flex items-center gap-2 text-lg font-bold">
            <slot name="title"> Modal </slot>
          </h2>
          <button @click="popupOpened = false">
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
