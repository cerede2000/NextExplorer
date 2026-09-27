import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Which file the Versions panel shows. The browser opens it on an item, an
 * editor on a bare path; both must end up naming the same file, or the panel
 * lists the history of something else.
 */

vi.mock('@/api', () => ({
  normalizePath: (value) =>
    String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, ''),
}));

import { useVersionsPanelStore } from './versionsPanel';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the Versions panel store', () => {
  it('opens on an item and names it by its full path', () => {
    const store = useVersionsPanelStore();

    store.open({ name: 'notes.md', path: '/Docs/', kind: 'md' });

    expect(store.isOpen).toBe(true);
    expect(store.relativePath).toBe('Docs/notes.md');
  });

  it('names an item at the top of a volume by its name alone', () => {
    const store = useVersionsPanelStore();

    store.open({ name: 'notes.md', path: '' });

    expect(store.relativePath).toBe('notes.md');
  });

  it('opens on a path the way an editor knows it, naming the same file', () => {
    const store = useVersionsPanelStore();

    store.openPath('/Docs/Reports/q3.docx');

    expect(store.isOpen).toBe(true);
    expect(store.item).toEqual({ name: 'q3.docx', path: 'Docs/Reports', kind: 'file' });
    expect(store.relativePath).toBe('Docs/Reports/q3.docx');
  });

  it('stays shut when there is nothing to open on', () => {
    const store = useVersionsPanelStore();

    store.openPath('');
    expect(store.isOpen).toBe(false);

    store.open(null);
    expect(store.isOpen).toBe(false);
    expect(store.relativePath).toBe('');
  });

  it('keeps the file it showed when it is closed', () => {
    const store = useVersionsPanelStore();
    store.openPath('Docs/notes.md');

    store.close();

    expect(store.isOpen).toBe(false);
    expect(store.relativePath).toBe('Docs/notes.md');
  });

  it('counts the restores, so an editor on the same file knows to reload', () => {
    const store = useVersionsPanelStore();

    store.markRestored();
    store.markRestored();

    expect(store.restored).toBe(2);
  });
});
