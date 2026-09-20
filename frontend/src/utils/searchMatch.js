/**
 * Which half of the search a result came from.
 *
 * A result carrying a matched line was found by its contents and one without
 * it by its name, and until this was said out loud the only way to tell was to
 * notice that something was missing — and only by comparing two results with
 * each other.
 *
 * The server now says of every result whether its name matched, asked of the
 * matcher rather than inferred from which pass produced it, and whether a line
 * is being shown. This turns the pair into the one word to put on screen.
 *
 * @param {{matchedName?: boolean, matchedContent?: boolean}} item
 * @returns {string|null} a translation key, or null when there is nothing to say
 */
export const matchLabelKey = (item) => {
  const byName = Boolean(item?.matchedName);
  const byContent = Boolean(item?.matchedContent);

  if (byName && byContent) return 'search.matchedByBoth';
  if (byContent) return 'search.matchedByContent';
  if (byName) return 'search.matchedByName';
  // An answer from a server that predates the question, or a result neither
  // half claims. Saying nothing is better than guessing which it was.
  return null;
};
