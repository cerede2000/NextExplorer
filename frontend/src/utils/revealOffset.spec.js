import { describe, it, expect } from 'vitest';
import { revealOffset } from './revealOffset';

/**
 * A search result opens the folder that holds the file, and the file is
 * usually below the fold — so the folder looks as though nothing was found.
 * In a virtualised list the row is not in the DOM until the scroll position
 * brings it in, so this is computed and not measured, and every edge below is
 * one where a wrong answer shows as a folder that opens somewhere unexpected.
 */
const viewport = { rowHeight: 37, viewportHeight: 600, maxScrollTop: 100000 };

describe('scrolling so a row can be seen', () => {
  it('leaves the top alone for a row already on the first screen', () => {
    expect(revealOffset({ ...viewport, index: 0 })).toBe(0);
    expect(revealOffset({ ...viewport, index: 3 })).toBe(0);
  });

  it('puts a row from further down about a third of the way in', () => {
    const offset = revealOffset({ ...viewport, index: 500 });

    // The row sits at 18 500; a third of a 600px viewport is 200 above it.
    expect(offset).toBe(500 * 37 - 200);
  });

  // A row near the end cannot be a third of the way down: there is not enough
  // document below it, and asking for it would scroll past the end.
  it('does not scroll past the end for a row near the bottom', () => {
    const offset = revealOffset({ ...viewport, index: 9999, maxScrollTop: 1200 });

    expect(offset).toBe(1200);
  });

  it('answers zero when there is nothing to scroll', () => {
    expect(revealOffset({ ...viewport, index: 500, maxScrollTop: 0 })).toBe(0);
  });

  // Called before layout, or on a folder whose rows have no measured height.
  it('answers zero rather than a wrong place when it has no measurements', () => {
    expect(revealOffset({ ...viewport, index: 500, rowHeight: 0 })).toBe(0);
    expect(revealOffset({ ...viewport, index: -1 })).toBe(0);
    expect(revealOffset({ ...viewport, index: Number.NaN })).toBe(0);
  });
});
