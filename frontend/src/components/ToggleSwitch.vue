<script setup>
import { computed } from 'vue';

// Accessible on/off switch. The knob position is driven by Vue state (not a CSS
// `peer-checked:` sibling selector, which silently fails when the knob is nested
// inside the track), so the knob actually SLIDES left↔right — the active state is
// unmistakable: knob on the right + a green track, vs knob on the left + a grey
// track.
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'md' }, // 'md' | 'sm'
});
const emit = defineEmits(['update:modelValue']);

const toggle = () => {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
};

const dims = computed(() =>
  props.size === 'sm'
    ? { track: 'h-5 w-9', knob: 'h-4 w-4', on: 'translate-x-[18px]', off: 'translate-x-[2px]' }
    : { track: 'h-6 w-11', knob: 'h-5 w-5', on: 'translate-x-[22px]', off: 'translate-x-[2px]' }
);
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    @click.stop="toggle"
    class="relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-zinc-900"
    :class="[dims.track, modelValue ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600']"
  >
    <span
      class="pointer-events-none inline-block transform rounded-full bg-white shadow ring-1 ring-black/5 transition-transform duration-200 ease-in-out"
      :class="[dims.knob, modelValue ? dims.on : dims.off]"
    ></span>
  </button>
</template>
