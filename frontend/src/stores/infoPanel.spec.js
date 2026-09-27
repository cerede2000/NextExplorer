import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useInfoPanelStore } from './infoPanel';

vi.mock('@/api', () => ({
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));

/**
 * The side panel that describes whatever is selected.
 *
 * Thirty-three lines, and the only thing in them worth guarding is the path it
 * hands to whoever fetches the metadata: a parent and a name joined, both
 * normalised. Getting that wrong asks the server about a different file than
 * the one on screen, and the panel then shows somebody else's size and dates
 * with no sign anything went astray.
 */

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('opening it', () => {
  it('shows the item it was given', () => {
    const store = useInfoPanelStore();
    const item = { name: 'a.txt', path: 'Docs' };

    store.open(item);

    expect(store.isOpen).toBe(true);
    expect(store.item).toEqual(item);
  });

  /** Opening on nothing is a close, not an empty panel. */
  it.each([
    ['nothing', null],
    ['undefined', undefined],
  ])('stays shut when opened on %s', (_label, value) => {
    const store = useInfoPanelStore();

    store.open(value);

    expect(store.isOpen).toBe(false);
    expect(store.item).toBeNull();
  });

  it('replaces what it was showing', () => {
    const store = useInfoPanelStore();
    store.open({ name: 'a.txt', path: 'Docs' });

    store.open({ name: 'b.txt', path: 'Media' });

    expect(store.item.name).toBe('b.txt');
  });
});

describe('closing it', () => {
  /**
   * The item is kept on purpose: the panel animates out, and clearing it would
   * blank the content mid-transition.
   */
  it('hides the panel but keeps what it was showing', () => {
    const store = useInfoPanelStore();
    store.open({ name: 'a.txt', path: 'Docs' });

    store.close();

    expect(store.isOpen).toBe(false);
    expect(store.item).not.toBeNull();
  });
});

describe('the path it asks the server about', () => {
  it('joins the parent and the name', () => {
    const store = useInfoPanelStore();

    store.open({ name: 'a.txt', path: 'Docs/2026' });

    expect(store.relativePath).toBe('Docs/2026/a.txt');
  });

  it('is just the name at the root of a volume', () => {
    const store = useInfoPanelStore();

    store.open({ name: 'a.txt', path: '' });

    expect(store.relativePath).toBe('a.txt');
  });

  it('normalises stray slashes on either side of the join', () => {
    const store = useInfoPanelStore();

    store.open({ name: 'a.txt', path: '/Docs/' });

    expect(store.relativePath).toBe('Docs/a.txt');
  });

  it('is empty when there is nothing to describe', () => {
    const store = useInfoPanelStore();

    expect(store.relativePath).toBe('');
  });

  /** No name means no file; asking about the parent would describe the folder. */
  it('is empty for an item with no name', () => {
    const store = useInfoPanelStore();

    store.open({ path: 'Docs' });

    expect(store.relativePath).toBe('');
  });

  it('follows the item when it changes', () => {
    const store = useInfoPanelStore();
    store.open({ name: 'a.txt', path: 'Docs' });

    store.open({ name: 'b.txt', path: 'Media' });

    expect(store.relativePath).toBe('Media/b.txt');
  });
});
