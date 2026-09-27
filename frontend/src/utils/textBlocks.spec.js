import { describe, expect, it } from 'vitest';

import { longestBlockLength, longestLineLength } from './textBlocks';

describe('the longest line of a text', () => {
  it('is nothing for nothing', () => {
    expect(longestLineLength('')).toBe(0);
    expect(longestLineLength(null)).toBe(0);
  });

  it('is the whole text when it is one line', () => {
    expect(longestLineLength('{"a":1,"b":2}')).toBe(13);
  });

  it('is the longest of its lines, wherever it is', () => {
    expect(longestLineLength('short\na much longer line\nmid')).toBe(18);
    expect(longestLineLength('mid\nshort\na much longer line')).toBe(18);
    expect(longestLineLength('a much longer line\n')).toBe(18);
  });
});

/**
 * How the editor tells a Markdown file it can colour from one whose parser
 * would hold the page: by its longest block. A wrong answer either freezes the
 * page on a file with no blank line, or takes the colours away from an
 * ordinary long document for nothing.
 */

describe('the longest block of a text', () => {
  it('is nothing for nothing', () => {
    expect(longestBlockLength('')).toBe(0);
    expect(longestBlockLength(undefined)).toBe(0);
    expect(longestBlockLength('\n\n  \n')).toBe(0);
  });

  it('is the whole text when no blank line interrupts it', () => {
    const text = 'one\ntwo\nthree';

    expect(longestBlockLength(text)).toBe(text.length);
  });

  it('is the longest of the blocks a blank line separates', () => {
    const short = 'a short one';
    const long = 'a much longer block\nthat runs over two lines';

    expect(longestBlockLength(`${short}\n\n${long}\n\n${short}`)).toBe(`${long}\n`.length);
  });

  it('counts a line of spaces, tabs or a Windows line ending as blank', () => {
    const text = 'first block\r\n \t\r\nsecond, longer block';

    expect(longestBlockLength(text)).toBe('second, longer block'.length);
  });

  /** The case that froze the editor: every line short, no line blank. */
  it('grows with a document that never leaves a blank line, however short its lines', () => {
    const lines = Array.from({ length: 10000 }, (unused, i) => `line ${i} of prose`).join('\n');

    expect(longestBlockLength(lines)).toBe(lines.length);
    expect(longestBlockLength(lines.replaceAll('\n', '\n\n'))).toBeLessThan(40);
  });
});
