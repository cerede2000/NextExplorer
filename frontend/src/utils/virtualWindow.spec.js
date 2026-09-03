import { describe, expect, it } from 'vitest';

import {
  LIST_ROW_HEIGHT,
  LIST_ROW_OVERSCAN,
  VIRTUAL_LIST_THRESHOLD,
  virtualWindow,
} from './virtualWindow';

/**
 * Which rows the list view renders, and the empty space that stands in for the
 * rest.
 *
 * A folder of ten thousand files is ten thousand components unless something
 * stops it, so above a threshold the list renders a window and props the
 * scrollbar up with two spacers. Small arithmetic, and entirely unforgiving:
 * too few rows and there is visible blank space mid-scroll, a wrong spacer and
 * the scrollbar lies about how much is below, an end index past the array and
 * the last screen comes up short.
 *
 * The invariant worth more than any single case is that the two spacers plus
 * the rendered rows always come to the full height of the list. That is what
 * keeps the scrollbar honest, and it holds at every scroll position or it holds
 * at none.
 */

const window_ = (overrides = {}) =>
  virtualWindow({
    itemCount: 5000,
    view: 'list',
    scrollTop: 0,
    viewportHeight: 800,
    visibleLimit: 500,
    ...overrides,
  });

describe('when it does not virtualise at all', () => {
  it('renders up to the limit in a small folder', () => {
    const result = window_({ itemCount: 40 });

    expect(result.virtualised).toBe(false);
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(500);
  });

  it('stays off at exactly the threshold, and comes on one row past it', () => {
    expect(window_({ itemCount: VIRTUAL_LIST_THRESHOLD }).virtualised).toBe(false);
    expect(window_({ itemCount: VIRTUAL_LIST_THRESHOLD + 1 }).virtualised).toBe(true);
  });

  /** Only the list view has uniform rows to measure; the others cannot be. */
  it.each(['grid', 'tab', 'photos'])('never virtualises the %s view', (view) => {
    expect(window_({ view, itemCount: 100000 }).virtualised).toBe(false);
  });

  it('leaves no spacers, since everything rendered is really there', () => {
    const result = window_({ itemCount: 40 });

    expect(result.topSpacerHeight).toBe(0);
    expect(result.bottomSpacerHeight).toBe(0);
  });

  it('says there is more when the limit cuts the folder short', () => {
    expect(window_({ itemCount: 900, visibleLimit: 500 }).hasMore).toBe(true);
    expect(window_({ itemCount: 400, visibleLimit: 500 }).hasMore).toBe(false);
  });

  /**
   * "Load more" belongs to this path only: a window always has rows below it,
   * so offering the button there would be a button that never goes away.
   */
  it('never says there is more while virtualising', () => {
    expect(window_({ itemCount: 100000 }).hasMore).toBe(false);
  });
});

describe('the window itself', () => {
  it('starts at the top before anything is scrolled', () => {
    expect(window_({ scrollTop: 0 }).startIndex).toBe(0);
  });

  /** Rows kept above the viewport, or a fast scroll shows blank space. */
  it('keeps rows above the viewport once there is room for them', () => {
    const scrolled = window_({ scrollTop: 100 * LIST_ROW_HEIGHT });

    expect(scrolled.startIndex).toBe(100 - LIST_ROW_OVERSCAN);
  });

  it('does not start before the first row when the overscan would go negative', () => {
    expect(window_({ scrollTop: 5 * LIST_ROW_HEIGHT }).startIndex).toBe(0);
  });

  it('covers the viewport plus overscan at both ends', () => {
    const result = window_({ scrollTop: 100 * LIST_ROW_HEIGHT, viewportHeight: 20 * LIST_ROW_HEIGHT });

    expect(result.endIndex - result.startIndex).toBe(20 + LIST_ROW_OVERSCAN * 2);
  });

  /** Past the end of the array is a short last screen. */
  it('never ends past the last row', () => {
    const result = window_({ itemCount: 1500, scrollTop: 1490 * LIST_ROW_HEIGHT });

    expect(result.endIndex).toBe(1500);
  });

  it('still renders something at the very bottom', () => {
    const result = window_({ itemCount: 1500, scrollTop: 1499 * LIST_ROW_HEIGHT });

    expect(result.endIndex).toBeGreaterThan(result.startIndex);
  });
});

describe('the spacers that keep the scrollbar honest', () => {
  /**
   * The property that matters more than any case: whatever is rendered, the two
   * spacers and the rows between them come to the full height of the list. Miss
   * it and the scrollbar reports a length the folder does not have.
   */
  it.each([0, 1, 37, 500, 3700, 50_000, 999_999])(
    'top + rendered + bottom is the whole list at scrollTop %i',
    (scrollTop) => {
      const itemCount = 5000;
      const result = window_({ itemCount, scrollTop });
      const rendered = (result.endIndex - result.startIndex) * LIST_ROW_HEIGHT;

      expect(result.topSpacerHeight + rendered + result.bottomSpacerHeight).toBe(
        itemCount * LIST_ROW_HEIGHT
      );
    }
  );

  it('holds for an awkward folder size too', () => {
    for (const itemCount of [1001, 1234, 9999]) {
      const result = window_({ itemCount, scrollTop: 400 * LIST_ROW_HEIGHT });
      const rendered = (result.endIndex - result.startIndex) * LIST_ROW_HEIGHT;

      expect(result.topSpacerHeight + rendered + result.bottomSpacerHeight).toBe(
        itemCount * LIST_ROW_HEIGHT
      );
    }
  });

  it('leaves nothing below once the window reaches the end', () => {
    const result = window_({ itemCount: 1500, scrollTop: 1500 * LIST_ROW_HEIGHT });

    expect(result.bottomSpacerHeight).toBe(0);
  });

  it('never asks for a negative spacer', () => {
    const result = window_({ itemCount: 1001, scrollTop: 999_999, viewportHeight: 10_000 });

    expect(result.topSpacerHeight).toBeGreaterThanOrEqual(0);
    expect(result.bottomSpacerHeight).toBeGreaterThanOrEqual(0);
  });
});

describe('inputs that are not what they should be', () => {
  it('treats an empty folder as empty rather than throwing', () => {
    expect(window_({ itemCount: 0 })).toMatchObject({ virtualised: false, hasMore: false });
  });

  it.each([
    ['no state at all', undefined],
    ['an empty object', {}],
  ])('answers for %s', (_label, input) => {
    expect(() => virtualWindow(input)).not.toThrow();
  });

  it.each([
    ['a negative count', { itemCount: -5 }],
    ['a count that is not a number', { itemCount: 'lots' }],
    ['a scroll position that is not a number', { scrollTop: 'down' }],
    ['a viewport height that is not a number', { viewportHeight: null }],
  ])('does not produce nonsense for %s', (_label, overrides) => {
    const result = window_(overrides);

    expect(result.startIndex).toBeGreaterThanOrEqual(0);
    expect(result.endIndex).toBeGreaterThanOrEqual(result.startIndex);
    expect(result.topSpacerHeight).toBeGreaterThanOrEqual(0);
    expect(result.bottomSpacerHeight).toBeGreaterThanOrEqual(0);
  });
});
