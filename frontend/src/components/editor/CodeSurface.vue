<template>
  <div ref="host" class="h-full" />
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * CodeMirror, without a copy of the whole document on every keystroke.
 *
 * The editor used vue-codemirror's `v-model`. Every change made it turn the
 * whole document into a string to emit it, and the component then compared
 * that string with its prop — two full copies per key, and a comparison of
 * two such strings on top for "unsaved changes". On a nineteen-megabyte file
 * that was about 150 ms of frozen page per character typed.
 *
 * Here the document stays CodeMirror's. The text is taken once, when it is
 * saved. Whether there are unsaved changes is CodeMirror's own comparison with
 * the document last read or saved: two documents of different lengths differ
 * at once, and two of the same length share every part an edit did not touch,
 * which the comparison skips.
 *
 * The same setup vue-codemirror gave the editor: its basic setup, Tab to
 * indent, and a tab two columns wide.
 */

const props = defineProps({
  /** The document as read. A different value replaces the document. */
  content: { type: String, default: '' },
  /** Read once, when the editor is created; reconfigure through compartments. */
  extensions: { type: Array, default: () => [] },
  autofocus: { type: Boolean, default: false },
});

const emit = defineEmits(['ready', 'edit', 'dirty-change']);

const host = ref(null);
const view = shallowRef(null);

// The document last read or saved, and whether the one on screen differs.
let savedDoc = null;
let dirty = false;

const setDirty = (value) => {
  if (value === dirty) return;
  dirty = value;
  emit('dirty-change', value);
};

const trackChanges = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  // A replacement from `content` is not an edit: it is the new saved document.
  if (update.transactions.some((tr) => tr.annotation(Transaction.remote))) return;
  setDirty(!update.state.doc.eq(savedDoc));
  emit('edit');
});

onMounted(() => {
  const state = EditorState.create({
    doc: props.content,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      EditorState.tabSize.of(2),
      trackChanges,
      ...props.extensions,
    ],
  });
  savedDoc = state.doc;
  view.value = new EditorView({ state, parent: host.value });
  if (props.autofocus) view.value.focus();
  emit('ready', { view: view.value });
});

watch(
  () => props.content,
  (content) => {
    const current = view.value;
    if (!current) return;
    // The same text again is not a new document; replacing it would only throw
    // away the cursor and the undo history for nothing.
    if (current.state.doc.length === content.length && current.state.doc.toString() === content) {
      return;
    }
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: content },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
    savedDoc = current.state.doc;
    setDirty(false);
  }
);

onBeforeUnmount(() => {
  view.value?.destroy();
  view.value = null;
});

defineExpose({
  /** The document as it is now, to be saved; `String(snapshot())` is its text. */
  snapshot: () => view.value?.state.doc ?? null,
  /** Call with what `snapshot()` answered once that document has been written. */
  markSaved: (doc) => {
    if (!view.value || !doc) return;
    savedDoc = doc;
    setDirty(!view.value.state.doc.eq(savedDoc));
  },
  view,
});
</script>
