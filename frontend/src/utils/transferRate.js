/**
 * How fast a transfer is actually moving, measured over a trailing window.
 *
 * The obvious calculation — bytes so far divided by time since the start — is
 * the one to avoid: it keeps reporting a speed the transfer no longer has. A
 * connection that collapses halfway through still shows an optimistic figure
 * for minutes, and thirty seconds of pause halve a number nothing in the
 * network changed. Only a trailing window answers "how fast is this going
 * *now*".
 *
 * The window also absorbs how chunked uploads report progress: bytes are
 * acknowledged a chunk at a time, so the instantaneous rate between two events
 * alternates between zero and an absurd spike. Averaged across a few seconds,
 * those steps read as the steady rate they really are.
 */

const DEFAULT_WINDOW_MS = 3000;

// How long a rate survives without fresh bytes. A paused or stalled transfer
// must stop reporting the speed it had, rather than freeze on it.
const DEFAULT_STALE_MS = 2000;

const monotonicNow = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * @param {object} [options]
 * @param {number} [options.windowMs] How far back to measure.
 * @param {number} [options.staleMs] Silence after this long without new bytes.
 * @param {() => number} [options.now] Clock, injectable for tests. Monotonic by
 *   default, so a system clock change cannot produce a negative interval.
 */
export const createRateMeter = ({
  windowMs = DEFAULT_WINDOW_MS,
  staleMs = DEFAULT_STALE_MS,
  now = monotonicNow,
} = {}) => {
  let samples = [];

  const prune = (at) => {
    const cutoff = at - windowMs;
    const firstInWindow = samples.findIndex((sample) => sample.at >= cutoff);

    if (firstInWindow < 0) {
      // Everything predates the window — keep the newest as the new anchor.
      samples = samples.slice(-1);
      return;
    }

    // A sample from before the cutoff is kept only when the window alone
    // wouldn't span an interval; otherwise it would drag the measurement back
    // towards a speed the transfer has already left behind.
    const keepFrom = samples.length - firstInWindow >= 2 ? firstInWindow : firstInWindow - 1;
    if (keepFrom > 0) samples = samples.slice(keepFrom);
  };

  return {
    /** @param {number} bytes Total transferred so far, not a delta. */
    sample(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return;
      const at = now();
      const last = samples[samples.length - 1];

      // Bytes going backwards means the transfer resumed from an offset the
      // server had already acknowledged — a retried chunk. Measuring across
      // that point would report a negative rate, so the window starts over.
      if (last && bytes < last.bytes) {
        samples = [{ at, bytes }];
        return;
      }

      samples.push({ at, bytes });
      prune(at);
    },

    /** Bytes per second, or null when there is nothing honest to report. */
    rate() {
      if (samples.length < 2) return null;

      const at = now();
      const last = samples[samples.length - 1];
      if (at - last.at > staleMs) return null;

      const first = samples[0];
      const elapsedMs = last.at - first.at;
      if (elapsedMs <= 0) return null;

      const bytes = last.bytes - first.bytes;
      if (bytes <= 0) return 0;

      return (bytes / elapsedMs) * 1000;
    },

    /** Start over — used when a task moves on to a different set of bytes. */
    reset() {
      samples = [];
    },
  };
};
