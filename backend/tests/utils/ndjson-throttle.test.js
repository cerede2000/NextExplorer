import { describe, it, expect, vi, afterEach } from 'vitest';
import { throttleProgress } from '../../src/utils/ndjsonStream.js';

/**
 * A bulk operation reports once per item. Three thousand files meant three
 * thousand socket writes and as many reactive updates in the browser, for a
 * bar with a hundred distinct positions. Throttling is only safe if the last
 * position always arrives: a bar stuck at 97% reads as a hung operation.
 */

afterEach(() => vi.useRealTimers());

describe('Progress throttling', () => {
  it('keeps the first event and drops the flood behind it', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const report = throttleProgress(write, 100);

    for (let i = 1; i <= 500; i += 1) report({ type: 'progress', completedItems: i });

    // One write instead of five hundred.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].completedItems).toBe(1);
  });

  it('lets one through per interval', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const report = throttleProgress(write, 100);

    report({ type: 'progress', completedItems: 1 });
    vi.advanceTimersByTime(150);
    report({ type: 'progress', completedItems: 2 });
    vi.advanceTimersByTime(150);
    report({ type: 'progress', completedItems: 3 });

    expect(write).toHaveBeenCalledTimes(3);
  });

  it('flushes the last position when the work ends', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const report = throttleProgress(write, 100);

    report({ type: 'progress', completedItems: 1, percent: 0 });
    for (let i = 2; i <= 3000; i += 1) {
      report({ type: 'progress', completedItems: i, percent: Math.round((i / 3000) * 100) });
    }
    report.flush();

    // Whatever was held back, completion is what the user is left looking at.
    const last = write.mock.calls.at(-1)[0];
    expect(last.completedItems).toBe(3000);
    expect(last.percent).toBe(100);
  });

  it('does not write twice when nothing is pending', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const report = throttleProgress(write, 100);

    report({ type: 'progress', completedItems: 1 });
    report.flush();
    report.flush();

    expect(write).toHaveBeenCalledTimes(1);
  });
});
