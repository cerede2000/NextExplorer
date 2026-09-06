/**
 * Moving through a folder from the keyboard.
 *
 * Lifted out of FolderView, which CI measures at under two per cent covered and
 * which is the screen everybody uses. These are the decisions rather than the
 * plumbing: which row an arrow key reaches, which rows a held shift covers, and
 * which file a burst of typing finds. Each of them is wrong in a way somebody
 * sees immediately — the selection jumps somewhere unexpected — and none of
 * them needs a DOM to answer.
 */

/**
 * The row an arrow key reaches.
 *
 * With nothing active yet, down starts at the top and up starts at the bottom,
 * which is what makes the first keypress in a folder do something sensible
 * rather than nothing. Otherwise it moves one and stops at the ends: a list
 * that wrapped around would take somebody from the last file to the first
 * without their asking.
 */
export const nextIndexInDirection = (currentIndex, direction, count) => {
  if (count <= 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, currentIndex + direction));
};

/**
 * The rows a range covers, in list order whichever end it was built from.
 *
 * Shift-up from the middle anchors below the active row, and the slice bounds
 * have to come out the same way round either way.
 */
export const rangeBetween = (anchorIndex, activeIndex) =>
  anchorIndex <= activeIndex ? [anchorIndex, activeIndex] : [activeIndex, anchorIndex];

/**
 * Typed text, reduced to what a match should ignore.
 *
 * Accents are stripped so that typing `e` reaches `Éléonore`, and case is
 * folded with the locale's own rules rather than ASCII's.
 */
export const normalizeTypeaheadText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();

/**
 * The file a burst of typing finds, and the query it settled on.
 *
 * The search starts just after the active row and wraps, so typing the same
 * letter repeatedly walks through the files that begin with it instead of
 * sticking on the first one.
 *
 * When one more letter matches nothing, the letter starts a new search rather
 * than leaving the person stuck with a query that can no longer match anything:
 * somebody typing `re` in a folder with no `re…` almost always meant to jump to
 * `r`, then to `e`. The query that was settled on comes back with the match so
 * the caller records the same one the search used.
 *
 * @param {object[]} items in the order they are displayed
 * @param {string} query the accumulated text, already normalised
 * @param {number} activeIndex where the selection is now, or -1
 * @param {string} lastKey the key just typed, already normalised
 */
export const findTypeaheadMatch = (items, query, activeIndex, lastKey) => {
  if (!Array.isArray(items) || items.length === 0) return { match: null, query };

  const ordered = [...items.slice(activeIndex + 1), ...items.slice(0, activeIndex + 1)];
  const startingWith = (text) =>
    ordered.find((item) => normalizeTypeaheadText(item?.name).startsWith(text));

  const match = startingWith(query);
  if (match) return { match, query };

  if (query.length > 1 && lastKey) {
    const restarted = startingWith(lastKey);
    if (restarted) return { match: restarted, query: lastKey };
  }

  return { match: null, query };
};
