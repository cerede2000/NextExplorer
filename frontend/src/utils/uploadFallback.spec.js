import { describe, expect, it } from 'vitest';
import { FALLBACK_LADDER_MIB, nextFallbackMiB } from './uploadFallback';

const MIB = 1024 * 1024;

describe('auto-fallback chunk ladder', () => {
  describe('with no size remembered yet', () => {
    // The proxy accepted this much before giving up, so the next attempt has to
    // be smaller than that — anything larger fails the same way.
    it('starts below what the proxy actually took', () => {
      expect(nextFallbackMiB(null, 50 * MIB)).toBe(32);
      expect(nextFallbackMiB(null, 20 * MIB)).toBe(16);
      expect(nextFallbackMiB(null, 100 * MIB)).toBe(96);
    });

    // A proxy that stops reading without an error gives no byte count. There is
    // nothing to deduce from, so start at the top of the ladder and work down.
    it('starts at the top when nothing was observed', () => {
      expect(nextFallbackMiB(null, 0)).toBe(FALLBACK_LADDER_MIB[0]);
      expect(nextFallbackMiB(undefined, 0)).toBe(96);
    });

    // Under the smallest rung there is no smaller one to pick, so the ladder's
    // first size is used and the step-down below takes over if it fails too.
    it('falls back to the first rung when even the smallest is too large', () => {
      expect(nextFallbackMiB(null, 4 * MIB)).toBe(96);
    });
  });

  describe('with a size already remembered', () => {
    // That size has now failed as well, so the only useful move is down.
    it('steps down one rung', () => {
      expect(nextFallbackMiB(96, 0)).toBe(64);
      expect(nextFallbackMiB(64, 0)).toBe(32);
      expect(nextFallbackMiB(32, 0)).toBe(16);
      expect(nextFallbackMiB(16, 0)).toBe(8);
    });

    // At the bottom the problem is not body size. Returning null is what tells
    // the caller to revert to direct uploads and let the real error surface,
    // rather than retrying smaller and smaller for ever.
    it('gives up at the bottom of the ladder', () => {
      expect(nextFallbackMiB(8, 0)).toBeNull();
    });

    // A value from an older version, or one edited by hand in localStorage,
    // must not strand the upload: an unknown rung ends the ladder rather than
    // looping or throwing.
    it('gives up on a size that is not on the ladder', () => {
      expect(nextFallbackMiB(48, 0)).toBeNull();
      expect(nextFallbackMiB(1, 0)).toBeNull();
    });
  });

  it('never proposes a size outside the ladder', () => {
    const proposals = [
      nextFallbackMiB(null, 0),
      nextFallbackMiB(null, 50 * MIB),
      nextFallbackMiB(96, 0),
      nextFallbackMiB(16, 0),
    ];

    for (const proposal of proposals) {
      expect(FALLBACK_LADDER_MIB).toContain(proposal);
    }
  });
});
