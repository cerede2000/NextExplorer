/**
 * A pseudo-random generator that can be replayed.
 *
 * The property and cycle suites draw their cases at random, which is what lets
 * them reach states nobody thought to write down. A failure that cannot be
 * reproduced teaches nothing, though, so every draw comes from a seed the
 * failing assertion prints: run the suite again with that seed and the same
 * sequence comes back, step for step.
 *
 * mulberry32: small, fast, and good enough to spread cases — this is not
 * cryptography.
 */
const createRandom = (seed) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** An integer between min and max, both included. */
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (values) => values[int(0, values.length - 1)];
  const chance = (probability) => next() < probability;

  return { seed, next, int, pick, chance };
};

/**
 * The seeds a suite runs through: a fixed list by default, so CI is
 * deterministic, or the one in `TEST_SEED` to replay a reported failure.
 */
const seedsFor = (count, base = 1) => {
  if (process.env.TEST_SEED) return [Number(process.env.TEST_SEED)];
  return Array.from({ length: count }, (_, index) => base + index);
};

module.exports = { createRandom, seedsFor };
