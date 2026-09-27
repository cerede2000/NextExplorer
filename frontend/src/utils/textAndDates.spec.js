import { afterEach, describe, expect, it, vi } from 'vitest';

import { ellipses } from './ellipses';
import { calculateExpirationDate } from './datetime';

/**
 * Two pure helpers, both at zero, both used where being wrong is visible.
 *
 * `ellipses` shortens a filename for a column that will not fit it, keeping
 * both ends: the start says what it is, the extension at the end says what kind
 * of thing it is, and a truncation that drops either makes the row useless. The
 * invariant is that the result never exceeds the width it was given — a
 * shortener that overflows is worse than no shortener, because the layout it
 * was protecting is broken anyway.
 *
 * `calculateExpirationDate` turns "two weeks" into a date on a share link. Get
 * it wrong and a link outlives what it was meant to, which is the direction
 * nobody notices.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('shortening a name that will not fit', () => {
  it('leaves a short one alone', () => {
    expect(ellipses('notes.txt', 30)).toBe('notes.txt');
  });

  it('leaves one that fits exactly alone', () => {
    expect(ellipses('abcdefghij', 10)).toBe('abcdefghij');
  });

  it('keeps both ends, so the name and the extension both survive', () => {
    const result = ellipses('a-very-long-folder-name-indeed.txt', 20);

    expect(result).toContain('…');
    expect(result.startsWith('a-very')).toBe(true);
    expect(result.endsWith('.txt')).toBe(true);
  });

  /**
   * The invariant. Overflowing the width it was given breaks the layout this
   * exists to protect.
   */
  it.each([8, 12, 20, 31, 64])('never exceeds a width of %i', (max) => {
    const long = 'x'.repeat(200);

    expect(ellipses(long, max).length).toBeLessThanOrEqual(max);
  });

  it('honours an explicit split between the two ends', () => {
    expect(ellipses('abcdefghijklmnop', 12, { keepStart: 3, keepEnd: 4 })).toBe('abc…mnop');
  });

  it('takes a different ellipsis', () => {
    const result = ellipses('abcdefghijklmnop', 12, { ellipsis: '...' });

    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('answers empty rather than throwing on nothing', () => {
    expect(ellipses(null)).toBe('');
    expect(ellipses(undefined)).toBe('');
  });

  it('turns a number into text rather than failing on it', () => {
    expect(ellipses(1234567890, 30)).toBe('1234567890');
  });

  it('answers empty for a width of nothing', () => {
    expect(ellipses('anything', 0)).toBe('');
    expect(ellipses('anything', -5)).toBe('');
  });

  /** No room for both ends and a marker: the marker alone, trimmed to fit. */
  it('degrades to the ellipsis when the width barely allows one', () => {
    expect(ellipses('abcdefgh', 1)).toBe('…');
    expect(ellipses('abcdefgh', 3, { ellipsis: '...' })).toBe('...');
  });

  it('keeps only the start when told to keep nothing from the end', () => {
    expect(ellipses('abcdefghijkl', 10, { keepStart: 4, keepEnd: 0 })).toBe('abcd…');
  });

  it('treats a negative keep as zero rather than slicing backwards', () => {
    const result = ellipses('abcdefghijkl', 10, { keepStart: -4, keepEnd: -2 });

    expect(result).toBe('…');
  });
});

describe('when a share link expires', () => {
  const at = (iso) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };

  /**
   * Asserted as an offset from today rather than as a fixed date. `setDate` and
   * `setMonth` work in local time, so the calendar day an instant falls on
   * depends on the machine's zone — a hardcoded date passes in CI (UTC) and
   * fails in Paris or Auckland. The offset is what the setting means anyway.
   */
  const expected = (mutate) => {
    const date = new Date();
    mutate(date);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  };
  const dayOf = (date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];

  it('adds days', () => {
    at('2026-03-10T12:00:00Z');

    expect(dayOf(calculateExpirationDate({ value: 3, unit: 'days' }))).toEqual(
      expected((d) => d.setDate(d.getDate() + 3))
    );
  });

  it('adds weeks as seven days each', () => {
    at('2026-03-10T12:00:00Z');

    expect(dayOf(calculateExpirationDate({ value: 2, unit: 'weeks' }))).toEqual(
      expected((d) => d.setDate(d.getDate() + 14))
    );
  });

  it('adds months by the calendar, not by thirty days', () => {
    at('2026-03-10T12:00:00Z');

    expect(dayOf(calculateExpirationDate({ value: 1, unit: 'months' }))).toEqual(
      expected((d) => d.setMonth(d.getMonth() + 1))
    );
  });

  /** Crossing a year boundary is where a naive day count drifts. */
  it('crosses into the next year', () => {
    at('2026-12-20T12:00:00Z');

    const result = calculateExpirationDate({ value: 2, unit: 'weeks' });

    expect(dayOf(result)).toEqual(expected((d) => d.setDate(d.getDate() + 14)));
    expect(result.getFullYear()).toBe(2027);
  });

  /**
   * There is no 31 February. `setMonth` rolls into March, which is the
   * behaviour here and worth pinning rather than discovering.
   */
  it('rolls a short month forward rather than refusing', () => {
    at('2026-01-15T12:00:00Z');
    const january31 = new Date();
    january31.setDate(31);
    vi.setSystemTime(january31);

    const result = calculateExpirationDate({ value: 1, unit: 'months' });

    expect(result.getMonth()).toBe(2); // March, not a 31 February
  });

  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['a number', 30],
    ['a string', '30 days'],
    ['a value of zero', { value: 0, unit: 'days' }],
    ['no value at all', { unit: 'days' }],
    ['a unit nobody defined', { value: 3, unit: 'fortnights' }],
    ['no unit', { value: 3 }],
  ])('answers no expiry for %s', (_label, input) => {
    expect(calculateExpirationDate(input)).toBeNull();
  });

  it('does not move the clock it was asked about', () => {
    at('2026-03-10T12:00:00Z');
    const before = Date.now();

    calculateExpirationDate({ value: 5, unit: 'days' });

    expect(Date.now()).toBe(before);
  });
});
