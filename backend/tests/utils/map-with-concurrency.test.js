import { describe, it, expect } from 'vitest';

const { mapWithConcurrency } = require('../../src/utils/mapWithConcurrency');

/**
 * `Promise.all(list.map(...))` is fine for a list the code chose and quite
 * different for one a request brought with it. This is what keeps the number
 * of operations in flight ours rather than the caller's.
 */
describe('mapping with a bound on what is in flight', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

  it('never has more running than it was allowed', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 200 }, (unused, index) => index),
      async (value) => {
        running += 1;
        peak = Math.max(peak, running);
        await settle();
        running -= 1;
        return value;
      },
      4
    );

    expect(peak).toBe(4);
  });

  it('answers in the order it was asked, whatever finishes first', async () => {
    const result = await mapWithConcurrency(
      [30, 5, 20, 1],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return delay;
      },
      4
    );

    expect(result).toEqual([30, 5, 20, 1]);
  });

  it('does not start a worker for a list it does not have', async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], async () => {
      calls += 1;
    });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
