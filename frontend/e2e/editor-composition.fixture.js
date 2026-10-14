import { createApp, h } from 'vue';

import '../src/assets/main.css';
import CodeSurface from '../src/components/editor/CodeSurface.vue';

/**
 * The editor, reachable by the path a virtual keyboard inserts text through.
 *
 * Every other test types with key events, which is not how a phone or a tablet
 * types: there the keyboard runs a composition — a provisional string that is
 * revised and then committed — and the browser reports it through
 * `compositionstart`, `beforeinput` with `insertCompositionText`, and
 * `compositionend`. CodeMirror handles that path with code of its own, and the
 * document it ends up holding is the only thing that says whether it handled
 * it correctly.
 *
 * So the fixture publishes two things: the view, because the document
 * CodeMirror holds is the subject, and a count of the composition events,
 * because a test that drives nothing through that path would otherwise pass by
 * doing nothing at all.
 *
 * Where to listen is the whole subtlety. On Chromium CodeMirror attaches an
 * `EditContext` to its content element, and a composition then goes to that
 * object: `compositionstart` and `compositionend` on the element never fire,
 * and a witness waiting there reports nothing while text arrives correctly.
 * Measured here on a Pixel 7 profile — the events were 0 and the document had
 * the word. So the witness follows the editor: the `EditContext` when there is
 * one, the element otherwise, and it writes down which, because CodeMirror
 * moving between the two is itself something a test should notice.
 */
const LINES = 60;
const document_ = Array.from(
  { length: LINES },
  (_, index) => `line ${index + 1} — plain text, nothing composed yet`
).join('\n');

const compositions = { started: 0, ended: 0, updates: 0, path: 'none' };
window.__compositions = compositions;

const ready = ({ view }) => {
  window.__editorView = view;
  const content = view.contentDOM;
  const target = content.editContext || content;
  compositions.path = content.editContext ? 'editcontext' : 'dom';
  target.addEventListener('compositionstart', () => (compositions.started += 1));
  target.addEventListener('compositionupdate', () => (compositions.updates += 1));
  target.addEventListener('compositionend', () => (compositions.ended += 1));
  // What the `EditContext` reports instead of `beforeinput`: every revision of
  // the provisional word, and the commit. On the element path there is no such
  // event, and the three above carry the proof on their own.
  if (content.editContext) {
    content.editContext.addEventListener('textupdate', () => (compositions.updates += 1));
  }
  window.__editorReady = true;
};

createApp({
  render: () =>
    h('div', { class: 'flex h-screen w-screen flex-col overflow-hidden', 'data-test': 'page' }, [
      h('header', { class: 'border-b px-4 py-2 text-sm' }, `${LINES} lines`),
      h('section', { class: 'flex-1 min-h-0' }, [
        h('div', { class: 'flex h-full flex-col' }, [
          h(CodeSurface, {
            content: document_,
            autofocus: true,
            class: 'min-h-0 flex-1',
            onReady: ready,
          }),
        ]),
      ]),
    ]),
}).mount('#app');
