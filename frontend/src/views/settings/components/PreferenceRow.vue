<script setup>
/**
 * One preference: what it is called, what it does, and the control for it.
 *
 * The same eleven lines of markup were written out once per preference, twenty
 * times over, so the screen was four hundred lines of scaffolding with the
 * settings hidden inside it — and a row was as much work to read as to add.
 * Here the call site is the label, the sentence under it, and the control.
 */
defineProps({
  label: { type: String, required: true },
  help: { type: String, default: '' },
});
</script>

<template>
  <div
    class="flex items-center justify-between gap-4 border-b border-zinc-100 py-3 last:border-0 dark:border-zinc-800"
  >
    <div class="min-w-0">
      <div class="font-medium text-zinc-900 dark:text-zinc-100">{{ label }}</div>
      <div v-if="help" class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{{ help }}</div>
      <!-- Whatever this row has to say about what is in it: a value that will
           not be accepted, a consequence worth knowing before saving. -->
      <slot name="note" />
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot />
    </div>
  </div>
</template>
