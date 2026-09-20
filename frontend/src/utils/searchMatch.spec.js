import { describe, expect, it } from 'vitest';
import { matchLabelKey } from './searchMatch';

/**
 * Saying which half of the search answered.
 *
 * The rule has to be the same on both screens, which is why it lives here
 * rather than twice in two templates.
 */
describe('what a search result was found by', () => {
  it('says contents when a line came back', () => {
    expect(matchLabelKey({ matchedName: false, matchedContent: true })).toBe(
      'search.matchedByContent'
    );
  });

  it('says name when no line did', () => {
    expect(matchLabelKey({ matchedName: true, matchedContent: false })).toBe(
      'search.matchedByName'
    );
  });

  // The case a reader could not tell apart before: listed once, by whichever
  // pass reserved the path first, so the line was there or not by accident.
  it('says both when both matched', () => {
    expect(matchLabelKey({ matchedName: true, matchedContent: true })).toBe('search.matchedByBoth');
  });

  it('says nothing rather than guessing', () => {
    expect(matchLabelKey({})).toBeNull();
    expect(matchLabelKey(null)).toBeNull();
    expect(matchLabelKey({ matchedName: false, matchedContent: false })).toBeNull();
  });
});
