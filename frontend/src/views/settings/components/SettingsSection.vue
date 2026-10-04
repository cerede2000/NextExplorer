<script setup>
import { inject, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * One theme of a settings screen, with a heading and a place in the index
 * beside it.
 *
 * The section hands its own element to whoever is keeping the index, rather
 * than being looked up by id afterwards. Two reasons: an element asked for
 * before it exists is not there — a measurement taken in a watcher that runs
 * immediately finds nothing — and this application can draw the same screen in
 * two panes at once, where one id would name two boxes and `getElementById`
 * would answer with whichever came first.
 */
const props = defineProps({
  /** Names this section in the index and in the address. */
  name: { type: String, required: true },
  title: { type: String, required: true },
});

const register = inject('settingsSections', null);
const box = ref(null);

onMounted(() => register?.hold(props.name, box.value));
onBeforeUnmount(() => register?.release(props.name));
</script>

<template>
  <section
    ref="box"
    class="scroll-mt-16 rounded-lg border border-zinc-200 bg-white p-4 md:p-6 dark:border-zinc-800 dark:bg-zinc-900"
  >
    <h3 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{{ title }}</h3>
    <div class="mt-1">
      <slot />
    </div>
  </section>
</template>
