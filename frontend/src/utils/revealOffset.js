/**
 * Where to scroll so that a given row lands on screen.
 *
 * A search result opens the folder that holds the file, and the file itself is
 * usually below the fold — the folder then looks as though nothing was found.
 * In a virtualised list the row does not exist in the DOM until the scroll
 * position brings it into the window, so the position has to be computed from
 * the index rather than read from an element.
 *
 * A third of the way down rather than centred: what sits above a file — the
 * folders it lives among — is context worth seeing, and pinning it to the very
 * top hides that it has any.
 */
const VIEWPORT_FRACTION = 3;

const revealOffset = ({ index, rowHeight, viewportHeight, maxScrollTop }) => {
  if (!Number.isFinite(index) || index < 0) return 0;
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return 0;

  const above = Number.isFinite(viewportHeight) ? viewportHeight / VIEWPORT_FRACTION : 0;
  const wanted = Math.max(0, index * rowHeight - above);

  // A row near the end cannot be a third of the way down: there is not enough
  // document below it, and asking for it would scroll past the end.
  if (!Number.isFinite(maxScrollTop) || maxScrollTop <= 0) return 0;
  return Math.min(wanted, maxScrollTop);
};

export { revealOffset, VIEWPORT_FRACTION };
