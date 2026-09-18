import { createApp, h } from 'vue';

// The application's stylesheet, because the classes around the editor are
// what give it a height to fill. Without it every element would lay itself
// out at its natural size, which contains nothing and proves nothing.
import '../src/assets/main.css';
import CodeSurface from '../src/components/editor/CodeSurface.vue';

/**
 * The editor in the shape the application puts it in: a column of a definite
 * height, a strip above it, and the editor taking the rest.
 *
 * That is CodeSurface's side of the contract — given a parent with a height,
 * the document scrolls inside the editor rather than past the bottom of the
 * page. The view's side, which is giving it that height, is covered by the
 * end-to-end suite against the real editor.
 */
const LINES = 900;
const document_ = Array.from(
  { length: LINES },
  (_, index) => `line ${index + 1} — long enough to be worth scrolling through`
).join('\n');

createApp({
  render: () =>
    h('div', { class: 'flex h-screen w-screen flex-col overflow-hidden', 'data-test': 'page' }, [
      h('header', { class: 'border-b px-4 py-2 text-sm' }, `${LINES} lines`),
      h('section', { class: 'flex-1 min-h-0' }, [
        h('div', { class: 'flex h-full flex-col' }, [
          h(CodeSurface, { content: document_, class: 'min-h-0 flex-1' }),
        ]),
      ]),
    ]),
}).mount('#app');
