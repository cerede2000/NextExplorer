import { defineStore } from 'pinia';
import { watch } from 'vue';
import { useTabsStore } from '@/stores/tabs';

/**
 * What was typed in a tab and never saved.
 *
 * The text editor is a page, and a page is unmounted the moment another tab comes
 * forward — so everything typed since the last save went with it, silently, for a
 * click that never said "discard". A document open in the preview does not have
 * this problem: its session lives in the preview manager and outlives the page
 * (see `plugins/preview/session.js`). This is the same idea for the one kind of
 * document that is not a preview, and it keeps the only thing that cannot be read
 * back from disk.
 *
 * Deliberately not the cursor, the selection or the undo history. Those live
 * inside CodeMirror, and keeping them would mean keeping the editor itself alive —
 * which the router cannot do for a page that is not on screen. What is at stake is
 * the text, and the text is what is kept.
 *
 * Kept in memory only, and per tab: a draft is something this window is holding on
 * to between two glances, not a second copy of somebody's file to be found later
 * in their browser's storage.
 */
export const useEditorDraftsStore = defineStore('editor-drafts', () => {
  const tabsStore = useTabsStore();

  /** tab id → `{ address, text }`. A plain Map: nothing is rendered from it. */
  const drafts = new Map();

  // A tab that goes takes its draft with it. Closing a tab is a decision about
  // what is in it, and keeping the text would only make it reappear in whatever
  // tab happened to be given the same id later.
  watch(
    () => tabsStore.tabs.map((tab) => tab.id),
    (ids) => {
      for (const id of [...drafts.keys()]) {
        if (!ids.includes(id)) drafts.delete(id);
      }
    }
  );

  /** Hold what is on screen, for the address it belongs to. */
  const keep = (key, address, text) => {
    if (!key || !address) return;
    drafts.set(key, { address, text });
  };

  const forget = (key) => {
    drafts.delete(key);
  };

  /**
   * What was kept for this tab at this address, or null.
   *
   * The address is half the question: a tab that was taken to another file has
   * nothing to do with the text typed into the previous one, and answering with
   * it would put one file's work into another file's editor.
   */
  const textFor = (key, address) => {
    const draft = drafts.get(key);
    return draft && draft.address === address ? draft.text : null;
  };

  return { keep, forget, textFor };
});
