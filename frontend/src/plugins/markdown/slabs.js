/**
 * Where a large Markdown document is cut, so the preview can render it a slab
 * at a time.
 *
 * A slab ends at a blank line, never inside a fenced code block: the cut then
 * falls between two blocks and the page reads exactly as if it had been
 * rendered whole. That is all this used to do, and a document that never
 * leaves a blank line — a log pasted into a `.md`, an export written one line
 * after another — was a single slab. Nineteen megabytes of it became one
 * paragraph: lexed in one call, sanitised in one call, and laid out by the
 * browser as one element, which froze the tab for as long as that took.
 *
 * So a slab that has gone well past its size without meeting a blank line is
 * cut where it can be, in this order of preference:
 *
 * - **At the end of a line**, outside a code block. A paragraph cut there
 *   becomes two paragraphs; nothing is lost from the text.
 * - **Before a code block** that would carry the slab past its reach: the
 *   block then starts the next slab, and stays whole if it fits in one.
 * - **At the end of a line inside a code block**, only once the block is far
 *   larger than any slab. The block is closed at the cut and opened again with
 *   the same fence at the start of the next slab, so the rest of the document
 *   is not swallowed by an unclosed fence. It reads as two code blocks.
 * - **At a space inside a line**, for a line longer than a slab on its own,
 *   and at the size itself when the line has no space in reach.
 */

/** How far past its size a slab looks for a blank line before cutting elsewhere. */
export const PARAGRAPH_REACH_FACTOR = 2;

/** How large a code block may grow in one slab before it is split. */
export const FENCE_REACH_BYTES = 1024 * 1024;

const FENCE = /^(`{3,}|~{3,})/;

/**
 * The next place to cut.
 *
 * @param {string} text the whole document
 * @param {number} from where this slab starts
 * @param {number} target the size this slab aims for
 * @param {{marker: string, line: string} | null} [openFence] the code block this slab starts inside
 * @returns {{end: number, fence: {marker: string, line: string} | null}} where the slab ends, and
 *   the code block left open at that point, which the next slab has to reopen
 */
export const nextSlabEnd = (text, from, target, openFence = null) => {
  const reach = target * PARAGRAPH_REACH_FACTOR;
  const fenceReach = Math.max(reach, FENCE_REACH_BYTES);
  let index = from;
  let fence = openFence;
  // Where the open code block began, when it began inside this slab.
  let fenceStart = -1;
  // The first line end past the target outside a code block: where a slab
  // that meets no blank line is cut.
  let lineEndPastTarget = -1;

  while (index < text.length) {
    let lineEnd = text.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = text.length;
    const reached = lineEnd - from;

    if (fence) {
      // End the slab before a block that would carry it past its reach.
      if (reached > reach && fenceStart > from) return { end: fenceStart, fence: null };
      // A block larger than a slab can hold is cut inside, at a line end.
      if (reached > fenceReach) {
        if (index > from) return { end: index, fence };
        return { end: cutInsideLine(text, from, fenceReach), fence };
      }
    } else if (reached > reach) {
      if (lineEndPastTarget !== -1) return { end: lineEndPastTarget, fence: null };
      if (index > from) return { end: index, fence: null };
      return { end: cutInsideLine(text, from, reach), fence: null };
    }

    let firstNonSpace = index;
    while (
      firstNonSpace < lineEnd &&
      (text[firstNonSpace] === ' ' || text[firstNonSpace] === '\t')
    ) {
      firstNonSpace += 1;
    }
    const blank = firstNonSpace === lineEnd;
    const opener = text[firstNonSpace];

    if (!blank && (opener === '`' || opener === '~')) {
      const marker = FENCE.exec(text.slice(firstNonSpace, lineEnd));
      if (marker) {
        if (fence && marker[1].startsWith(fence.marker[0])) {
          fence = null;
          fenceStart = -1;
        } else if (!fence) {
          fence = { marker: marker[1], line: text.slice(firstNonSpace, lineEnd) };
          fenceStart = index;
        }
      }
    }

    index = lineEnd + 1;
    const size = index - from;

    if (!fence && blank && size >= target) {
      return { end: Math.min(index, text.length), fence: null };
    }
    if (!fence && size >= target && lineEndPastTarget === -1) {
      lineEndPastTarget = Math.min(index, text.length);
    }
  }

  return { end: text.length, fence: null };
};

/** Inside one line: after the last space in reach, or at the reach itself. */
const cutInsideLine = (text, from, reach) => {
  const limit = Math.min(from + reach, text.length);
  const space = text.lastIndexOf(' ', limit - 1);
  let cut = space > from ? space + 1 : limit;
  // Never between the two halves of a character outside the basic plane.
  const previous = text.charCodeAt(cut - 1);
  if (cut < text.length && previous >= 0xd800 && previous <= 0xdbff) cut -= 1;
  return cut;
};

/**
 * The source to hand the lexer for one slab: reopening the code block the last
 * slab was cut inside, and closing the one this slab is cut inside.
 */
export const slabSource = (text, from, end, reopened, leftOpen) => {
  let source = text.slice(from, end);
  if (reopened) source = `${reopened.line}\n${source}`;
  if (leftOpen) source = `${source}${source.endsWith('\n') ? '' : '\n'}${leftOpen.marker}\n`;
  return source;
};
