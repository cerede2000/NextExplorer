<script setup>
import { computed } from 'vue';

/**
 * A description from the API's description, with its two bits of markup —
 * `code` and [a link](https://…) — drawn as such. Built as nodes, never as
 * HTML, so nothing in a description is ever run as markup.
 */
const props = defineProps({ text: { type: String, default: '' } });

const parts = computed(() => {
  const out = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const match of props.text.matchAll(pattern)) {
    if (match.index > last) out.push({ kind: 'text', value: props.text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'code', value: match[1] });
    else out.push({ kind: 'link', value: match[2], href: match[3] });
    last = match.index + match[0].length;
  }
  if (last < props.text.length) out.push({ kind: 'text', value: props.text.slice(last) });
  return out;
});
</script>

<template>
  <span
    ><template v-for="(part, index) in parts" :key="index"
      ><code v-if="part.kind === 'code'">{{ part.value }}</code
      ><a v-else-if="part.kind === 'link'" :href="part.href" rel="noopener">{{ part.value }}</a
      ><template v-else>{{ part.value }}</template></template
    ></span
  >
</template>
