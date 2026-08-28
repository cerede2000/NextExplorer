const MIB_BYTES = 1024 * 1024;

// Sizes tried when a direct upload is refused or silently stalled by a reverse
// proxy. Descending, because the whole point is to get under whatever limit the
// proxy enforces, and the common ones sit between these values.
export const FALLBACK_LADDER_MIB = [96, 64, 32, 16, 8];

/**
 * The chunk size to try next.
 *
 * With no size remembered for this origin, start below what the proxy actually
 * accepted before it gave up — anything larger would fail the same way. With a
 * size already remembered, that size has now failed too, so step down.
 *
 * Returns null once the smallest rung has failed: at 8 MiB the problem is not
 * body size, and the caller reverts to direct uploads and lets the real error
 * reach the user rather than retrying for ever.
 */
export const nextFallbackMiB = (currentMiB, observedBytes) => {
  if (!currentMiB) {
    const observedMiB = observedBytes > 0 ? Math.floor(observedBytes / MIB_BYTES) : Infinity;
    return FALLBACK_LADDER_MIB.find((size) => size < observedMiB) ?? FALLBACK_LADDER_MIB[0];
  }

  const index = FALLBACK_LADDER_MIB.indexOf(currentMiB);
  return index >= 0 && index + 1 < FALLBACK_LADDER_MIB.length
    ? FALLBACK_LADDER_MIB[index + 1]
    : null;
};
