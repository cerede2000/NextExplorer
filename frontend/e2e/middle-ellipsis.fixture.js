import { createApp, h } from 'vue';

// The application's stylesheet, without which none of the component's classes
// exist. Unstyled, the two halves of the name would be plain inline spans laid
// out at their natural size, no flex item would trim anything, and a test would
// agree with the very defect it is written to catch.
import '../src/assets/main.css';
import MiddleEllipsis from '../src/components/MiddleEllipsis.vue';

/**
 * One name, drawn twice.
 *
 * `#subject` is the component as the listing uses it, in a box far wider than
 * the name so nothing is truncated: what is measured is then the name itself,
 * not an ellipsis. `#reference` is the same string in one span that keeps its
 * spaces, which is what the name is supposed to look like.
 *
 * Both are given the same font by the stylesheet, so their drawn widths are
 * comparable, and a character the component loses shows up as a shortfall.
 */
const params = new URLSearchParams(window.location.search);
const name = params.get('name') ?? '02. Test messagerie';
const endChars = Number(params.get('endChars') ?? 10);

createApp({
  render: () =>
    h('div', { style: 'padding: 12px' }, [
      h('div', { id: 'subject', style: 'width: 600px' }, [
        h(MiddleEllipsis, { text: name, endChars }),
      ]),
      h('span', { id: 'reference', class: 'whitespace-pre' }, name),
    ]),
}).mount('#app');
