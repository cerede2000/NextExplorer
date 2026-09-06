import { describe, expect, it } from 'vitest';

import {
  nextIndexInDirection,
  rangeBetween,
  normalizeTypeaheadText,
  findTypeaheadMatch,
} from './folderKeyboard';

/**
 * Moving through a folder from the keyboard.
 *
 * Lifted out of FolderView, which CI measures at under two per cent covered and
 * which is the screen everybody uses. Each of these is wrong in a way somebody
 * sees at once: the arrow key lands on the wrong row, a held shift takes the
 * wrong range, or typing jumps to the wrong file.
 */

const items = ['Archive', 'budget.xlsx', 'Éléonore.txt', 'photos', 'report.pdf'].map((name) => ({
  name,
}));

const find = (query, activeIndex = -1, lastKey = query.slice(-1)) =>
  findTypeaheadMatch(items, query, activeIndex, lastKey);

describe('the row an arrow key reaches', () => {
  it('moves down one', () => {
    expect(nextIndexInDirection(1, 1, 5)).toBe(2);
  });

  it('moves up one', () => {
    expect(nextIndexInDirection(3, -1, 5)).toBe(2);
  });

  /**
   * A list that wrapped would take somebody from the last file to the first
   * without their asking for it.
   */
  it('stops at the bottom rather than wrapping', () => {
    expect(nextIndexInDirection(4, 1, 5)).toBe(4);
  });

  it('stops at the top rather than wrapping', () => {
    expect(nextIndexInDirection(0, -1, 5)).toBe(0);
  });

  /** The first keypress in a folder has to do something sensible. */
  it('starts at the top when nothing is active and the key is down', () => {
    expect(nextIndexInDirection(-1, 1, 5)).toBe(0);
  });

  it('starts at the bottom when nothing is active and the key is up', () => {
    expect(nextIndexInDirection(-1, -1, 5)).toBe(4);
  });

  it('has nowhere to go in an empty folder', () => {
    expect(nextIndexInDirection(-1, 1, 0)).toBe(-1);
    expect(nextIndexInDirection(2, 1, 0)).toBe(-1);
  });
});

describe('the rows a held shift covers', () => {
  it('runs from the anchor down to the active row', () => {
    expect(rangeBetween(1, 3)).toEqual([1, 3]);
  });

  /** Shift-up anchors below the active row, and the bounds still come out in order. */
  it('runs in list order when the anchor is below', () => {
    expect(rangeBetween(3, 1)).toEqual([1, 3]);
  });

  it('is a single row when both ends are the same', () => {
    expect(rangeBetween(2, 2)).toEqual([2, 2]);
  });
});

describe('what typing is reduced to before matching', () => {
  it('folds case', () => {
    expect(normalizeTypeaheadText('ARCHIVE')).toBe('archive');
  });

  /** So that typing `e` reaches `Éléonore`. */
  it('strips accents', () => {
    expect(normalizeTypeaheadText('Éléonore')).toBe('eleonore');
  });

  it('makes something of nothing', () => {
    expect(normalizeTypeaheadText(undefined)).toBe('');
    expect(normalizeTypeaheadText(null)).toBe('');
  });
});

describe('the file a burst of typing finds', () => {
  it('finds one by its first letter', () => {
    expect(find('b').match.name).toBe('budget.xlsx');
  });

  it('narrows as more letters arrive', () => {
    expect(find('re').match.name).toBe('report.pdf');
  });

  it('reaches an accented name from an unaccented key', () => {
    expect(find('el').match.name).toBe('Éléonore.txt');
  });

  it('ignores the case of the name as well as of the key', () => {
    expect(find('arch').match.name).toBe('Archive');
  });

  /**
   * The search starts after the active row and wraps, so the same letter twice
   * walks through the files beginning with it instead of sticking on the first.
   */
  it('starts looking after the row that is active', () => {
    const withB = ['budget.xlsx', 'bills.pdf', 'notes.txt'].map((name) => ({ name }));

    expect(findTypeaheadMatch(withB, 'b', 0, 'b').match.name).toBe('bills.pdf');
  });

  it('wraps back to the top when nothing after the active row matches', () => {
    const withB = ['budget.xlsx', 'bills.pdf', 'notes.txt'].map((name) => ({ name }));

    expect(findTypeaheadMatch(withB, 'b', 1, 'b').match.name).toBe('budget.xlsx');
  });

  /**
   * Somebody typing `r` then `e` in a folder with no `re…` almost always meant
   * to jump to `r` and then to `e`, rather than to be left with a query that
   * can no longer match anything.
   */
  it('starts a new search from the last letter when the pair matches nothing', () => {
    const { match, query } = findTypeaheadMatch(items, 'bp', -1, 'p');

    expect(match.name).toBe('photos');
    expect(query).toBe('p');
  });

  /** And says which query it settled on, so the caller records the same one. */
  it('reports the query it used when it did not restart', () => {
    expect(find('re').query).toBe('re');
  });

  it('finds nothing when even the last letter matches nothing', () => {
    const { match, query } = findTypeaheadMatch(items, 'zq', -1, 'q');

    expect(match).toBeNull();
    expect(query).toBe('zq');
  });

  /** A single letter that matches nothing has no shorter query to fall back to. */
  it('does not restart on a single letter', () => {
    expect(find('z').match).toBeNull();
  });

  it('finds nothing in an empty folder', () => {
    expect(findTypeaheadMatch([], 'b', -1, 'b').match).toBeNull();
    expect(findTypeaheadMatch(undefined, 'b', -1, 'b').match).toBeNull();
  });

  it('is not upset by an item with no name', () => {
    expect(findTypeaheadMatch([{}, { name: 'budget.xlsx' }], 'b', -1, 'b').match.name).toBe(
      'budget.xlsx'
    );
  });
});
