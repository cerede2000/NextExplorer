/** Above this many rows, the list view renders a window instead of everything. */
export const VIRTUAL_LIST_THRESHOLD = 1000;

/** Height of one row in the list view, in pixels. */
export const LIST_ROW_HEIGHT = 37;

/**
 * Rows kept rendered above and below the viewport.
 *
 * Without them a fast scroll outruns the recalculation and shows blank space
 * where rows should be. Twenty is enough for a flick on a trackpad.
 */
export const LIST_ROW_OVERSCAN = 20;

/**
 * Which rows to render, and how much empty space to leave above and below them.
 *
 * A folder of ten thousand files is ten thousand components unless something
 * stops it, so the list view renders a window and props the scrollbar up with
 * two spacers. The arithmetic is small and entirely unforgiving: too few rows
 * and there is visible blank space mid-scroll, a wrong spacer and the scrollbar
 * lies about how much is left, an end index past the array and the last screen
 * is short.
 *
 * Lifted out of `FolderView.vue` — 1226 lines and fifteen stores — because this
 * is the part worth testing and none of the rest of that file is needed to
 * do it.
 *
 * @param {object} state
 * @param {number} state.itemCount how many rows the folder holds
 * @param {string} state.view the current view mode; only 'list' virtualises
 * @param {number} state.scrollTop pixels scrolled
 * @param {number} state.viewportHeight visible height in pixels
 * @param {number} state.visibleLimit rows shown when not virtualising
 */
export const virtualWindow = ({
  itemCount = 0,
  view = 'list',
  scrollTop = 0,
  viewportHeight = 0,
  visibleLimit = 500,
} = {}) => {
  const count = Math.max(0, Number(itemCount) || 0);
  const virtualised = view === 'list' && count > VIRTUAL_LIST_THRESHOLD;

  if (!virtualised) {
    const end = Math.min(count, Math.max(0, Number(visibleLimit) || 0));
    return {
      virtualised: false,
      startIndex: 0,
      endIndex: Math.max(0, Number(visibleLimit) || 0),
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      // "Load more" belongs to the un-virtualised path only: the window always
      // has more below it, and offering a button for that would never stop.
      hasMore: end < count,
    };
  }

  const startIndex = Math.max(
    0,
    Math.floor((Number(scrollTop) || 0) / LIST_ROW_HEIGHT) - LIST_ROW_OVERSCAN
  );
  const visibleCount =
    Math.ceil((Number(viewportHeight) || 0) / LIST_ROW_HEIGHT) + LIST_ROW_OVERSCAN * 2;
  const endIndex = Math.min(count, startIndex + visibleCount);

  return {
    virtualised: true,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * LIST_ROW_HEIGHT,
    bottomSpacerHeight: Math.max(0, (count - endIndex) * LIST_ROW_HEIGHT),
    hasMore: false,
  };
};
