import { describe, it, expect } from 'vitest';
import { createRateMeter } from './transferRate';

/**
 * The rate has to describe the transfer as it is now, not as it was on
 * average. Everything here is about the moments where those two answers
 * differ — and about the ways progress reporting misbehaves in practice.
 */

const meterAt = (options = {}) => {
  const clock = { value: 0 };
  const meter = createRateMeter({ now: () => clock.value, ...options });
  return {
    meter,
    /** Advance the clock, then record the running total. */
    at(ms, bytes) {
      clock.value = ms;
      meter.sample(bytes);
    },
    tick(ms) {
      clock.value = ms;
    },
    rate: () => meter.rate(),
  };
};

const MB = 1024 * 1024;

describe('createRateMeter', () => {
  it('says nothing until it has two points to measure across', () => {
    const m = meterAt();
    expect(m.rate()).toBeNull();

    m.at(0, 0);
    expect(m.rate()).toBeNull();

    m.at(1000, MB);
    expect(m.rate()).toBe(MB);
  });

  it('follows the current rate rather than the average since the start', () => {
    // Fast for a while, then the connection collapses. An average would still
    // be reporting most of the original speed; the window must not.
    const m = meterAt({ windowMs: 3000 });
    m.at(0, 0);
    m.at(1000, 10 * MB);
    m.at(2000, 20 * MB);
    expect(m.rate()).toBe(10 * MB);

    m.at(3000, 20.1 * MB);
    m.at(4000, 20.2 * MB);
    m.at(5000, 20.3 * MB);

    // Only the last three seconds count: 0.2 MB over 2s once the window has
    // moved past the fast part.
    expect(m.rate()).toBeCloseTo(0.1 * MB, 0);
  });

  it('reads a chunked upload as a steady rate, not a series of spikes', () => {
    // Chunks land whole: nothing, nothing, 8 MB at once. Between two events
    // that is either zero or an impossible burst — across the window it is
    // simply 8 MB/s.
    const m = meterAt({ windowMs: 3000 });
    m.at(0, 0);
    m.at(500, 0);
    m.at(1000, 8 * MB);
    m.at(1500, 8 * MB);
    m.at(2000, 16 * MB);

    expect(m.rate()).toBe(8 * MB);
  });

  it('starts over when the byte count goes backwards', () => {
    // A retried chunk resumes from the offset the server acknowledged, so the
    // running total drops. The rate must never come out negative.
    const m = meterAt();
    m.at(0, 0);
    m.at(1000, 10 * MB);
    m.at(2000, 6 * MB);

    expect(m.rate()).toBeNull();

    m.at(3000, 8 * MB);
    expect(m.rate()).toBe(2 * MB);
  });

  it('falls silent when the bytes stop arriving', () => {
    // Pausing an upload stops the events. Holding the last rate on screen
    // would claim a transfer is moving when it is not.
    const m = meterAt({ staleMs: 2000 });
    m.at(0, 0);
    m.at(1000, 10 * MB);
    expect(m.rate()).toBe(10 * MB);

    m.tick(2500);
    expect(m.rate()).toBe(10 * MB);

    m.tick(3500);
    expect(m.rate()).toBeNull();
  });

  it('reports zero while a transfer is stalled but still reporting', () => {
    // Distinct from silence: events keep coming, they just carry no progress.
    const m = meterAt();
    m.at(0, 10 * MB);
    m.at(500, 10 * MB);
    m.at(1000, 10 * MB);

    expect(m.rate()).toBe(0);
  });

  it('keeps measuring across a window that has just been pruned', () => {
    // Dropping every sample older than the window would leave a single point
    // and no interval, so the rate would blink out on a steady transfer.
    const m = meterAt({ windowMs: 1000 });
    m.at(0, 0);
    m.at(900, 9 * MB);
    m.at(1800, 18 * MB);
    m.at(2700, 27 * MB);

    expect(m.rate()).toBeCloseTo(10 * MB, -3);
  });

  it('ignores values that are not usable byte counts', () => {
    const m = meterAt();
    m.at(0, 0);
    m.meter.sample(Number.NaN);
    m.meter.sample(-1);
    m.meter.sample(undefined);
    m.at(1000, MB);

    expect(m.rate()).toBe(MB);
  });

  it('forgets everything on reset', () => {
    const m = meterAt();
    m.at(0, 0);
    m.at(1000, 10 * MB);
    m.meter.reset();

    expect(m.rate()).toBeNull();
  });
});
