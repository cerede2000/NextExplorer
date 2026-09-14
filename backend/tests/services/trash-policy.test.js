import { describe, expect, it } from 'vitest';

import { createRandom, seedsFor } from '../helpers/seeded-random.js';

const {
  budgetFor,
  planMaintenance,
  admission,
  DAY_MS,
} = require('../../src/services/trash/policy');

/**
 * What the trash keeps and what it lets go, decided without touching a disk.
 *
 * The rule is small and its consequences are not: an item evicted a day too
 * early is a file someone expected to find, and an item never evicted is a
 * volume that fills up. So the decision is a pure function of the inventory,
 * the hour and the space, and it is held two ways — cases written by hand for
 * what the design promises, and properties checked against inventories drawn
 * at random, for what nobody thought to write down.
 */

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const GB = 1024 ** 3;

const item = (id, { daysAgo = 0, size = 1 } = {}) => ({
  id,
  size,
  deletedAt: NOW - daysAgo * DAY_MS,
});

const plan = (items, overrides = {}) =>
  planMaintenance({
    items,
    now: NOW,
    retentionDays: 30,
    budgetBytes: Infinity,
    freeBytes: Infinity,
    floorBytes: 0,
    ...overrides,
  });

const ids = (result) => result.purge.map((entry) => entry.id);

describe('the budget of a zone', () => {
  it('is the configured share of the volume', () => {
    expect(budgetFor({ totalBytes: 2000 * GB, maxPercent: 10 })).toBe(200 * GB);
  });

  it('is the smaller of the share and the configured size', () => {
    expect(budgetFor({ totalBytes: 2000 * GB, maxPercent: 10, maxBytes: 20 * GB })).toBe(20 * GB);
    expect(budgetFor({ totalBytes: 100 * GB, maxPercent: 10, maxBytes: 20 * GB })).toBe(10 * GB);
  });

  /** A filesystem that cannot be measured is held to the size alone, if there is one. */
  it('falls back on the configured size when the volume cannot be measured', () => {
    expect(budgetFor({ totalBytes: null, maxPercent: 10, maxBytes: 5 * GB })).toBe(5 * GB);
    expect(budgetFor({ totalBytes: null, maxPercent: 10 })).toBe(Infinity);
  });

  it('whole bytes, never a fraction of one', () => {
    expect(Number.isInteger(budgetFor({ totalBytes: 1001, maxPercent: 10 }))).toBe(true);
  });
});

describe('admitting an item', () => {
  it('lets in what fits in the budget, even if older items must make room', () => {
    expect(admission({ size: 15 * GB, budgetBytes: 20 * GB })).toBe('fits');
  });

  it('refuses what is larger than the whole budget', () => {
    expect(admission({ size: 48 * GB, budgetBytes: 20 * GB })).toBe('too-large');
  });

  it('lets in anything when nothing bounds the zone', () => {
    expect(admission({ size: 48 * GB, budgetBytes: Infinity })).toBe('fits');
  });
});

describe('a maintenance plan', () => {
  it('keeps everything younger than the retention when there is room', () => {
    expect(ids(plan([item('a', { daysAgo: 29 }), item('b', { daysAgo: 1 })]))).toEqual([]);
  });

  it('lets go of what has reached the retention, and says why', () => {
    const result = plan([item('old', { daysAgo: 30 }), item('new', { daysAgo: 2 })]);

    expect(result.purge).toEqual([{ id: 'old', reason: 'expired', early: false }]);
  });

  /** The retention is a maximum, applied every time — not only when space runs out. */
  it('expires items even when the zone is nearly empty', () => {
    const result = plan([item('ancient', { daysAgo: 400, size: 1 })], {
      budgetBytes: 1000 * GB,
      freeBytes: 1000 * GB,
    });

    expect(ids(result)).toEqual(['ancient']);
  });

  it('honours a retention other than thirty days', () => {
    expect(ids(plan([item('a', { daysAgo: 8 })], { retentionDays: 7 }))).toEqual(['a']);
    expect(ids(plan([item('a', { daysAgo: 6 })], { retentionDays: 7 }))).toEqual([]);
  });

  it('evicts the oldest first when the budget is exceeded, and marks it early', () => {
    const result = plan(
      [
        item('newest', { daysAgo: 1, size: 4 }),
        item('oldest', { daysAgo: 10, size: 4 }),
        item('middle', { daysAgo: 5, size: 4 }),
      ],
      { budgetBytes: 8 }
    );

    expect(result.purge).toEqual([{ id: 'oldest', reason: 'budget', early: true }]);
    expect(result.usedAfter).toBe(8);
  });

  it('stops evicting as soon as the zone fits', () => {
    const result = plan(
      [
        item('a', { daysAgo: 3, size: 5 }),
        item('b', { daysAgo: 2, size: 5 }),
        item('c', { daysAgo: 1, size: 5 }),
      ],
      { budgetBytes: 11 }
    );

    expect(ids(result)).toEqual(['a']);
  });

  it('counts the expired items towards making room before evicting anything else', () => {
    const result = plan(
      [item('expired', { daysAgo: 45, size: 10 }), item('recent', { daysAgo: 1, size: 10 })],
      { budgetBytes: 10 }
    );

    expect(result.purge).toEqual([{ id: 'expired', reason: 'expired', early: false }]);
  });

  /** The disk filling up for another reason: the trash gives its space back before an upload is refused. */
  it('evicts when free space falls under the floor, even within the budget', () => {
    const result = plan(
      [item('a', { daysAgo: 3, size: 30 }), item('b', { daysAgo: 1, size: 30 })],
      { budgetBytes: 1000, freeBytes: 50, floorBytes: 64 }
    );

    expect(result.purge).toEqual([{ id: 'a', reason: 'space', early: true }]);
    expect(result.freeAfter).toBe(80);
  });

  it('empties the zone when even that is not enough, and no further', () => {
    const result = plan(
      [item('a', { daysAgo: 3, size: 10 }), item('b', { daysAgo: 1, size: 10 })],
      {
        freeBytes: 0,
        floorBytes: 1000,
      }
    );

    expect(ids(result)).toEqual(['a', 'b']);
  });

  it('breaks a tie on the deletion time by identifier, so a plan is always the same', () => {
    const result = plan([item('b', { daysAgo: 2, size: 5 }), item('a', { daysAgo: 2, size: 5 })], {
      budgetBytes: 5,
    });

    expect(ids(result)).toEqual(['a']);
  });

  it('treats an unknown free space as plenty rather than as none', () => {
    expect(ids(plan([item('a', { size: 10 })], { freeBytes: null, floorBytes: 64 }))).toEqual([]);
  });

  it('plans nothing for an empty zone', () => {
    expect(plan([])).toEqual({ purge: [], usedAfter: 0, freeAfter: Infinity });
  });
});

/**
 * Properties, over inventories nobody wrote by hand. Each seed is printed on
 * failure; `TEST_SEED=<n>` replays that one.
 */
describe('a maintenance plan, over random inventories', () => {
  const draw = (random) => {
    const count = random.int(0, 25);
    const items = Array.from({ length: count }, (_, index) =>
      item(`item-${index}`, { daysAgo: random.int(0, 60), size: random.int(0, 100) })
    );
    return {
      items,
      retentionDays: random.pick([1, 7, 30, 90]),
      budgetBytes: random.chance(0.2) ? Infinity : random.int(0, 1500),
      freeBytes: random.chance(0.2) ? null : random.int(0, 2000),
      floorBytes: random.int(0, 300),
    };
  };

  it.each(seedsFor(300))('holds for seed %i', (seed) => {
    const random = createRandom(seed);
    const input = draw(random);
    // The settings alone: spreading `input` whole would carry its `items` over
    // whatever inventory a call is given.
    const settings = { ...input };
    delete settings.items;
    const result = plan(input.items, settings);
    const purged = new Set(ids(result));
    const kept = input.items.filter((entry) => !purged.has(entry.id));
    const retentionMs = input.retentionDays * DAY_MS;
    const expired = (entry) => entry.deletedAt + retentionMs <= NOW;
    const context = `seed ${seed}`;

    // Every expired item goes, whatever the space.
    expect(kept.filter(expired), context).toEqual([]);

    // What stays fits: the budget holds and the floor is respected, unless
    // nothing is left to give.
    const used = kept.reduce((total, entry) => total + entry.size, 0);
    expect(result.usedAfter, context).toBe(used);
    if (kept.length > 0) {
      expect(used, context).toBeLessThanOrEqual(input.budgetBytes);
      if (Number.isFinite(input.freeBytes)) {
        expect(result.freeAfter, context).toBeGreaterThanOrEqual(input.floorBytes);
      }
    }

    // Early evictions take the oldest: nothing kept is older than something
    // evicted before its time.
    const early = input.items.filter((entry) =>
      result.purge.some((planned) => planned.id === entry.id && planned.early)
    );
    for (const evicted of early) {
      expect(expired(evicted), context).toBe(false);
      for (const survivor of kept) {
        expect(evicted.deletedAt, context).toBeLessThanOrEqual(survivor.deletedAt);
      }
    }

    // Applying the plan and planning again finds nothing left to do.
    const again = plan(kept, {
      ...settings,
      freeBytes: result.freeAfter === Infinity ? null : result.freeAfter,
    });
    expect(again.purge, context).toEqual([]);

    // Nothing is planned twice, and nothing unknown is planned at all.
    expect(purged.size, context).toBe(result.purge.length);
    for (const id of purged) {
      expect(
        input.items.some((entry) => entry.id === id),
        context
      ).toBe(true);
    }
  });
});
