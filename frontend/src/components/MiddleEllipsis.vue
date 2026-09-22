<script setup>
import { computed } from 'vue';

const props = defineProps({
  text: {
    type: String,
    required: true,
    default: '',
  },
  endChars: {
    type: Number,
    default: 10,
  },
});

/**
 * The name as it is drawn.
 *
 * The two halves below are laid out as flex items, and `white-space: pre` is
 * what keeps a space that lands on the cut — see the template. `pre` also
 * honours a line break, though, and a name may hold one (nothing but `/` and
 * NUL is refused on Linux), which would make the row two lines tall inside a
 * listing that expects one. A break is therefore drawn as a space, which is
 * what the collapsing display showed before.
 */
const drawnText = computed(() => String(props.text ?? '').replace(/[\r\n]+/g, ' '));

const startText = computed(() => {
  if (drawnText.value.length <= props.endChars) {
    return drawnText.value;
  }
  return drawnText.value.slice(0, -props.endChars);
});

const endText = computed(() => {
  if (drawnText.value.length <= props.endChars) {
    return '';
  }
  return drawnText.value.slice(-props.endChars);
});
</script>

<template>
  <!--
    The name is split so its end — an extension, a number — stays readable when
    the row is too narrow: the start takes the ellipsis, the end never shrinks.
    The split happens whatever the width, so when there is room the two halves
    have to read as one uninterrupted name.

    That is why both halves are `whitespace-pre` rather than `nowrap`. A flex
    item drops the white space at the edges of its line, so a cut landing on a
    space ate it: "02. Test messagerie" was drawn "02. Testmessagerie". `pre`
    keeps spaces exactly where the name has them, at the edges included, and
    still never wraps, so the ellipsis works as before.
  -->
  <span class="flex min-w-0 pr-2 overflow-hidden max-w-full">
    <span class="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{{ startText }}</span>
    <span v-if="endText" class="shrink-0 whitespace-pre">{{ endText }}</span>
  </span>
</template>
