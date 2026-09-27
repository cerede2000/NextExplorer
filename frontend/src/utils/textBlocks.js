/**
 * The length of the longest run of lines in `text` that no blank line
 * interrupts.
 *
 * CodeMirror's Markdown parser reads a document block by block, a little at a
 * time, so a large document is highlighted without holding the page. What it
 * cannot divide is one block: a paragraph is read whole once it ends. A
 * nineteen-megabyte file that never leaves a blank line is one paragraph, and
 * reading it held the page for five and a half seconds here — longer on a
 * slower machine — right after the editor had opened.
 *
 * Written over the string rather than over `split('\n')`, which would hold the
 * document a second time in hundreds of thousands of pieces.
 */
export const longestBlockLength = (text) => {
  if (typeof text !== 'string' || text.length === 0) return 0;

  let longest = 0;
  let blockStart = -1;
  let index = 0;

  while (index <= text.length) {
    let lineEnd = text.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = text.length;

    let blank = true;
    for (let at = index; at < lineEnd; at += 1) {
      const code = text.charCodeAt(at);
      // Space, tab and the carriage return of a Windows line ending.
      if (code !== 32 && code !== 9 && code !== 13) {
        blank = false;
        break;
      }
    }

    if (blank) {
      if (blockStart !== -1) longest = Math.max(longest, index - blockStart);
      blockStart = -1;
    } else if (blockStart === -1) {
      blockStart = index;
    }

    index = lineEnd + 1;
  }

  if (blockStart !== -1) longest = Math.max(longest, text.length - blockStart);
  return longest;
};

/**
 * The length of the longest line in `text`.
 *
 * The other parsers divide a document by lines, and a single line is where
 * they cannot: a nineteen-megabyte JSON file written on one line held the page
 * in jolts of up to 220 ms for six seconds after it opened, three seconds
 * frozen in all. The same size written over ordinary lines — YAML, a log —
 * opened in well under a tenth of a second.
 */
export const longestLineLength = (text) => {
  if (typeof text !== 'string' || text.length === 0) return 0;

  let longest = 0;
  let index = 0;
  while (index <= text.length) {
    let lineEnd = text.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = text.length;
    longest = Math.max(longest, lineEnd - index);
    index = lineEnd + 1;
  }
  return longest;
};
