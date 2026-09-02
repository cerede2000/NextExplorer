import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a click, a Ctrl-click and a Shift-click select.
 *
 * Eighty-nine lines that run on every click in the explorer, at 1.8%. Selection
 * is what every destructive action reads afterwards, so an off-by-one in the
 * range is a file deleted that nobody meant to delete.
 *
 * The subtle part is the anchor. Shift-click extends from the *last* item
 * selected, not the first, and it works in both directions — so the range has
 * to be normalised before slicing or a backwards drag selects nothing.
 */

let store;

vi.mock('@/api', () => ({
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/stores/fileStore', () => ({ useFileStore: () => store }));

import { useSelection } from './itemSelection';

const item = (name, path = 'Docs') => ({ name, path, kind: 'txt' });
const LIST = ['a', 'b', 'c', 'd', 'e'].map((n) => item(`${n}.txt`));

const makeStore = (selected = []) => {
  const state = {
    getCurrentPathItems: LIST,
    selectedItems: selected,
    get selectedItemKeys() {
      return new Set(state.selectedItems.map((i) => `${i.path}::${i.name}`));
    },
  };
  return state;
};

const names = () => store.selectedItems.map((i) => i.name);

beforeEach(() => {
  store = makeStore();
});

describe('a plain click', () => {
  it('selects one thing and drops everything else', () => {
    store = makeStore([item('a.txt'), item('b.txt')]);

    useSelection().handleSelection(item('d.txt'), {});

    expect(names()).toEqual(['d.txt']);
  });

  it('selects with no event at all', () => {
    useSelection().handleSelection(item('c.txt'));

    expect(names()).toEqual(['c.txt']);
  });

  /**
   * The object from a row is not the object in the listing. Selecting the row's
   * copy means later comparisons against the listing miss.
   */
  it('selects the listing’s object, not the copy it was handed', () => {
    useSelection().handleSelection({ name: 'c.txt', path: 'Docs' }, {});

    expect(store.selectedItems[0]).toBe(LIST[2]);
  });

  it('keeps an item the listing does not contain rather than dropping it', () => {
    useSelection().handleSelection(item('gone.txt'), {});

    expect(names()).toEqual(['gone.txt']);
  });
});

describe('Ctrl-click, and Cmd-click', () => {
  it.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
  ])('%s adds to the selection', (_label, event) => {
    store = makeStore([item('a.txt')]);

    useSelection().handleSelection(item('c.txt'), event);

    expect(names()).toEqual(['a.txt', 'c.txt']);
  });

  it('removes something already selected', () => {
    store = makeStore([item('a.txt'), item('c.txt')]);

    useSelection().handleSelection(item('a.txt'), { ctrlKey: true });

    expect(names()).toEqual(['c.txt']);
  });

  it('removes the right one when several are selected', () => {
    store = makeStore([item('a.txt'), item('b.txt'), item('c.txt')]);

    useSelection().handleSelection(item('b.txt'), { ctrlKey: true });

    expect(names()).toEqual(['a.txt', 'c.txt']);
  });

  /** A new array every time, or a memoised list never notices the change. */
  it('replaces the array rather than mutating it in place', () => {
    const before = [item('a.txt')];
    store = makeStore(before);

    useSelection().handleSelection(item('c.txt'), { ctrlKey: true });

    expect(store.selectedItems).not.toBe(before);
    expect(before).toHaveLength(1);
  });
});

describe('Shift-click', () => {
  it('extends from the last selected item, downwards', () => {
    store = makeStore([item('b.txt')]);

    useSelection().handleSelection(item('d.txt'), { shiftKey: true });

    expect(names()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  /** Backwards is the same range. Slicing without normalising selects nothing. */
  it('extends upwards just as well', () => {
    store = makeStore([item('d.txt')]);

    useSelection().handleSelection(item('b.txt'), { shiftKey: true });

    expect(names()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  it('anchors on the last item selected, not the first', () => {
    store = makeStore([item('a.txt'), item('c.txt')]);

    useSelection().handleSelection(item('e.txt'), { shiftKey: true });

    expect(names()).toEqual(['c.txt', 'd.txt', 'e.txt']);
  });

  it('selects just the one when shift-clicking where you already are', () => {
    store = makeStore([item('c.txt')]);

    useSelection().handleSelection(item('c.txt'), { shiftKey: true });

    expect(names()).toEqual(['c.txt']);
  });

  it('falls back to a plain click when nothing is selected yet', () => {
    useSelection().handleSelection(item('c.txt'), { shiftKey: true });

    expect(names()).toEqual(['c.txt']);
  });

  /**
   * The anchor can be stale — selected, then the folder re-listed without it.
   * Selecting the range to a vanished anchor would select an arbitrary span.
   */
  it('selects only the target when the anchor is no longer in the listing', () => {
    store = makeStore([item('vanished.txt')]);

    useSelection().handleSelection(item('d.txt'), { shiftKey: true });

    expect(names()).toEqual(['d.txt']);
  });

  it('does nothing when the target itself is not in the listing', () => {
    store = makeStore([item('b.txt')]);

    useSelection().handleSelection(item('ghost.txt'), { shiftKey: true });

    expect(names()).toEqual(['b.txt']);
  });

  it('selects the whole listing from end to end', () => {
    store = makeStore([item('a.txt')]);

    useSelection().handleSelection(item('e.txt'), { shiftKey: true });

    expect(names()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  });
});

describe('Ctrl beats Shift when both are held', () => {
  it('toggles rather than extending', () => {
    store = makeStore([item('a.txt')]);

    useSelection().handleSelection(item('d.txt'), { ctrlKey: true, shiftKey: true });

    expect(names()).toEqual(['a.txt', 'd.txt']);
  });
});

describe('clearing', () => {
  it('uses the store’s own clear when it has one', () => {
    const clearSelection = vi.fn();
    store = makeStore([item('a.txt')]);
    store.clearSelection = clearSelection;

    useSelection().clearSelection();

    expect(clearSelection).toHaveBeenCalled();
  });

  it('empties the list itself when the store offers nothing', () => {
    store = makeStore([item('a.txt')]);

    useSelection().clearSelection();

    expect(names()).toEqual([]);
  });
});

describe('asking whether something is selected', () => {
  it('matches on the parent as well as the name', () => {
    store = makeStore([item('a.txt', 'Docs')]);
    const selection = useSelection();

    expect(selection.isSelected(item('a.txt', 'Docs'))).toBe(true);
    expect(selection.isSelected(item('a.txt', 'Other'))).toBe(false);
  });

  it('is false for something with no name', () => {
    store = makeStore([item('a.txt')]);

    expect(useSelection().isSelected({ path: 'Docs' })).toBe(false);
  });
});
