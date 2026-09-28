import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * What a tab holds on to between two glances.
 *
 * Two rules, and both of them are about *not* handing text back: a draft belongs
 * to one address, and it goes when its tab does. Get either wrong and somebody's
 * unsaved work turns up inside another file, which is worse than losing it —
 * losing it they would notice.
 */

import { useEditorDraftsStore } from './editorDrafts';
import { useTabsStore } from '@/stores/tabs';

const ADDRESS = '/editor/Docs/notes.md';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('a draft belongs to a tab and an address', () => {
  it('is handed back to the tab that left it, at the address it was left at', () => {
    const drafts = useEditorDraftsStore();
    drafts.keep('tab-1', ADDRESS, 'half a sentence');

    expect(drafts.textFor('tab-1', ADDRESS)).toBe('half a sentence');
  });

  /** Another file in the same tab: this text has nothing to do with it. */
  it('is not handed to another address', () => {
    const drafts = useEditorDraftsStore();
    drafts.keep('tab-1', ADDRESS, 'half a sentence');

    expect(drafts.textFor('tab-1', '/editor/Docs/other.md')).toBeNull();
  });

  it('is not handed to another tab', () => {
    const drafts = useEditorDraftsStore();
    drafts.keep('tab-1', ADDRESS, 'half a sentence');

    expect(drafts.textFor('tab-2', ADDRESS)).toBeNull();
  });

  it('is nothing at all until something is kept', () => {
    const drafts = useEditorDraftsStore();

    expect(drafts.textFor('tab-1', ADDRESS)).toBeNull();
  });

  /** An empty draft is still a draft: everything deleted and not yet saved. */
  it('keeps an empty document, which is a change like any other', () => {
    const drafts = useEditorDraftsStore();
    drafts.keep('tab-1', ADDRESS, '');

    expect(drafts.textFor('tab-1', ADDRESS)).toBe('');
  });

  it('is gone once it is let go of', () => {
    const drafts = useEditorDraftsStore();
    drafts.keep('tab-1', ADDRESS, 'half a sentence');

    drafts.forget('tab-1');

    expect(drafts.textFor('tab-1', ADDRESS)).toBeNull();
  });
});

describe('a tab that goes', () => {
  /**
   * Closing a tab is a decision about what is in it. Kept, the text would come
   * back in whatever tab was later given the same identifier.
   */
  it('takes its draft with it', async () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const second = tabs.open('/editor/Docs/notes.md', { own: true });
    const drafts = useEditorDraftsStore();
    drafts.keep(second.id, ADDRESS, 'half a sentence');

    tabs.close(second.id);
    await nextTick();

    expect(drafts.textFor(second.id, ADDRESS)).toBeNull();
  });

  it('leaves the other tabs holding theirs', async () => {
    const tabs = useTabsStore();
    tabs.setEnabled(true);
    const first = tabs.activeId;
    const second = tabs.open('/editor/Docs/notes.md', { own: true });
    const drafts = useEditorDraftsStore();
    drafts.keep(first, ADDRESS, 'kept');
    drafts.keep(second.id, ADDRESS, 'goes');

    tabs.close(second.id);
    await nextTick();

    expect(drafts.textFor(first, ADDRESS)).toBe('kept');
  });
});
