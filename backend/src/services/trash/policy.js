/**
 * What the trash keeps and what it lets go.
 *
 * A pure function of the inventory, the hour and the space: no disk, no
 * database, no clock of its own. The maintenance pass gathers the facts and
 * applies the plan; this only decides. That split is what lets the rule be
 * checked against thousands of inventories in the time a single disk-backed
 * test would take.
 *
 * The order, from the design:
 *   1. whatever has reached its retention goes, whatever the space — the
 *      retention is a maximum, not something applied when space runs out;
 *   2. then, while the zone is over its budget or the volume under its free
 *      space floor, the oldest item goes, and the eviction is marked early so
 *      it can be shown rather than happen silently.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const isPositive = (value) => Number.isFinite(value) && value > 0;

/**
 * The most a zone may hold: the configured share of the volume, capped by the
 * configured size when there is one. A volume that cannot be measured is held
 * to the size alone, and to nothing when there is no size either.
 */
const budgetFor = ({ totalBytes, maxPercent, maxBytes } = {}) => {
  const limits = [];
  if (isPositive(totalBytes) && isPositive(maxPercent)) {
    limits.push(Math.floor((totalBytes * maxPercent) / 100));
  }
  if (isPositive(maxBytes)) limits.push(Math.floor(maxBytes));
  return limits.length ? Math.min(...limits) : Infinity;
};

/**
 * Whether an item may enter the zone at all. Something that fits in the budget
 * gets in, older items making room for it; something larger than the whole
 * budget never would, and the person deleting it has to be asked instead.
 */
const admission = ({ size, budgetBytes }) =>
  Number.isFinite(budgetBytes) && size > budgetBytes ? 'too-large' : 'fits';

const byAge = (left, right) =>
  left.deletedAt - right.deletedAt || String(left.id).localeCompare(String(right.id));

/**
 * @param {object} input
 * @param {{ id: string, size: number, deletedAt: number }[]} input.items
 * @param {number} input.now            milliseconds since the epoch
 * @param {number} input.retentionDays
 * @param {number} input.budgetBytes    Infinity when nothing bounds the zone
 * @param {number|null} input.freeBytes free space on the volume; null when unknown
 * @param {number} input.floorBytes     free space the volume must keep
 * @returns {{ purge: { id: string, reason: 'expired'|'budget'|'space', early: boolean }[],
 *   usedAfter: number, freeAfter: number }}
 */
const planMaintenance = ({
  items = [],
  now,
  retentionDays,
  budgetBytes = Infinity,
  freeBytes = null,
  floorBytes = 0,
}) => {
  const retentionMs = retentionDays * DAY_MS;
  const purge = [];
  const remaining = [];
  // Unknown free space is treated as plenty. Evicting someone's files because
  // statfs is unavailable would cost more than the risk it avoids.
  let free = Number.isFinite(freeBytes) ? freeBytes : Infinity;

  for (const entry of [...items].sort(byAge)) {
    if (entry.deletedAt + retentionMs <= now) {
      purge.push({ id: entry.id, reason: 'expired', early: false });
      free += entry.size;
    } else {
      remaining.push(entry);
    }
  }

  let used = remaining.reduce((total, entry) => total + entry.size, 0);
  let next = 0;
  while (next < remaining.length && (used > budgetBytes || free < floorBytes)) {
    const entry = remaining[next];
    next += 1;
    purge.push({ id: entry.id, reason: used > budgetBytes ? 'budget' : 'space', early: true });
    used -= entry.size;
    free += entry.size;
  }

  return { purge, usedAfter: used, freeAfter: free };
};

module.exports = { DAY_MS, budgetFor, admission, planMaintenance };
