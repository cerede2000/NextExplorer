/**
 * The trash's only source of the time.
 *
 * Retention is counted in days, and a test that waited thirty of them to see
 * an item expire would never be written. Everything in the trash asks this
 * module rather than `Date.now()`, so a test can move the hour and watch the
 * consequence at once.
 */
const clock = {
  now: () => Date.now(),
  nowIso: () => new Date(clock.now()).toISOString(),
};

module.exports = clock;
