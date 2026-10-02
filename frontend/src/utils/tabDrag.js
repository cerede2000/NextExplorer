/**
 * A tab being dragged, said in a way a drop target can recognise.
 *
 * The strip already writes the tab's id as plain text, because Firefox starts no
 * drag at all without something on the transfer. Plain text is not enough for a
 * pane, though: a pane takes drops of files as well, and "some text that happens
 * to look like an id" is not something to act on. So a tab drag also carries its
 * own type, and a target asks for that.
 *
 * The type is read from the *types* list rather than by reading the data, because
 * a browser refuses to hand over the data during `dragover` — which is exactly
 * when a target has to decide whether it wants the drop.
 */
export const TAB_DRAG_TYPE = 'application/x-nextexplorer-tab';

/** Whether what is being dragged is one of this application's tabs. */
export const isTabDrag = (event) =>
  Array.from(event?.dataTransfer?.types || []).includes(TAB_DRAG_TYPE);

/** Which tab, once the drop has happened and the data can be read. */
export const draggedTabId = (event) => event?.dataTransfer?.getData(TAB_DRAG_TYPE) || '';
