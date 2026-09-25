import { describe, expect, it } from 'vitest';

import { createRandom, seedsFor } from '../helpers/seeded-random.js';

const {
  HOUR_MS,
  DAY_MS,
  MINUTE_MS,
  bucketOf,
  thinVersions,
  sessionDecision,
  isStaleSave,
} = require('../../src/services/versions/policy');
const { planMaintenance, planZone } = require('../../src/services/trash/policy');

/**
 * Which earlier versions of a file are kept, decided without touching a disk.
 *
 * A version dropped too early is the one someone needed; a version never
 * dropped is a volume filling up with near copies of one document. The rules
 * are held the same two ways as the trash's own: cases written by hand for what
 * the design promises, and properties over histories drawn at random.
 */

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const SETTINGS = { keepAllHours: 24, hourlyDays: 7, dailyDays: 30, maxPerFile: 50 };

const version = (id, ageMs, extra = {}) => ({ id, modifiedAt: NOW - ageMs, ...extra });
const dropped = (versions, settings = SETTINGS) =>
  thinVersions({ versions, now: NOW, settings }).map((entry) => entry.id);

describe('thinning a file history over time', () => {
  it('keeps every version from the last day, however many there are', () => {
    const versions = Array.from({ length: 40 }, (_, index) =>
      version(`v${index}`, index * MINUTE_MS)
    );
    expect(dropped(versions)).toEqual([]);
  });

  it('keeps one version an hour for the first week, the newest of that hour', () => {
    const hourStart = Math.floor((NOW - 2 * DAY_MS) / HOUR_MS) * HOUR_MS;
    const versions = [
      { id: 'early', modifiedAt: hourStart + 5 * MINUTE_MS },
      { id: 'late', modifiedAt: hourStart + 50 * MINUTE_MS },
      { id: 'middle', modifiedAt: hourStart + 20 * MINUTE_MS },
      { id: 'next-hour', modifiedAt: hourStart + HOUR_MS + MINUTE_MS },
    ];
    const result = thinVersions({ versions, now: NOW, settings: SETTINGS });
    expect(result).toEqual([
      { id: 'middle', reason: 'thinned' },
      { id: 'early', reason: 'thinned' },
    ]);
  });

  it('keeps one version a day up to a month, then one a week', () => {
    const dayStart = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
    const weekStart = Math.floor((NOW - 60 * DAY_MS) / (7 * DAY_MS)) * 7 * DAY_MS;
    const versions = [
      { id: 'day-morning', modifiedAt: dayStart + 8 * HOUR_MS },
      { id: 'day-evening', modifiedAt: dayStart + 20 * HOUR_MS },
      { id: 'week-monday', modifiedAt: weekStart + DAY_MS },
      { id: 'week-friday', modifiedAt: weekStart + 5 * DAY_MS },
    ];
    expect(dropped(versions).sort()).toEqual(['day-morning', 'week-monday']);
  });

  it('follows the tiers an administrator set', () => {
    // 08:50 and 08:40 on a day the tests read at noon: the same hour.
    const versions = [
      version('a', 3 * HOUR_MS + 10 * MINUTE_MS),
      version('b', 3 * HOUR_MS + 20 * MINUTE_MS),
    ];
    expect(dropped(versions)).toEqual([]);
    expect(dropped(versions, { ...SETTINGS, keepAllHours: 1 })).toEqual(['b']);
  });

  it('keeps no more than the limit per file, letting the oldest go', () => {
    const versions = Array.from({ length: 5 }, (_, index) =>
      version(`v${index}`, index * MINUTE_MS)
    );
    expect(thinVersions({ versions, now: NOW, settings: { ...SETTINGS, maxPerFile: 3 } })).toEqual([
      { id: 'v3', reason: 'limit' },
      { id: 'v4', reason: 'limit' },
    ]);
  });

  it('never lets a pinned version go, and does not count it against the limit', () => {
    const versions = [
      version('pinned-old', 200 * DAY_MS, { pinned: true }),
      version('pinned-twin', 200 * DAY_MS + MINUTE_MS, { pinned: true }),
      version('recent-1', MINUTE_MS),
      version('recent-2', 2 * MINUTE_MS),
    ];
    expect(dropped(versions, { ...SETTINGS, maxPerFile: 2 })).toEqual([]);
  });

  it('treats a version dated in the future as brand new rather than dropping it', () => {
    expect(bucketOf(NOW + DAY_MS, NOW, SETTINGS)).toBeNull();
  });
});

describe('thinning, over random histories', () => {
  const draw = (random) =>
    Array.from({ length: random.int(0, 120) }, (_, index) => ({
      id: `v${index}`,
      modifiedAt:
        NOW -
        random.int(0, 400) * DAY_MS -
        random.int(0, 23) * HOUR_MS -
        random.int(0, 59) * MINUTE_MS,
      pinned: random.chance(0.05),
    }));

  it.each(seedsFor(200, 500))('holds its promises for seed %i', (seed) => {
    const random = createRandom(seed);
    const versions = draw(random);
    const settings = {
      keepAllHours: random.int(1, 72),
      hourlyDays: random.int(3, 14),
      dailyDays: random.int(15, 90),
      maxPerFile: random.int(1, 60),
    };
    const drop = new Set(thinVersions({ versions, now: NOW, settings }).map((entry) => entry.id));
    const kept = versions.filter((entry) => !drop.has(entry.id));
    const keptUnpinned = kept.filter((entry) => !entry.pinned);
    const context = `seed ${seed}`;

    expect(kept.filter((entry) => entry.pinned).length, context).toBe(
      versions.filter((entry) => entry.pinned).length
    );
    expect(keptUnpinned.length, context).toBeLessThanOrEqual(settings.maxPerFile);

    const unpinned = versions.filter((entry) => !entry.pinned);
    if (unpinned.length) {
      const newest = unpinned.reduce((best, entry) =>
        entry.modifiedAt > best.modifiedAt ||
        (entry.modifiedAt === best.modifiedAt && entry.id < best.id)
          ? entry
          : best
      );
      expect(drop.has(newest.id), context).toBe(false);
    }

    const buckets = keptUnpinned
      .map((entry) => bucketOf(entry.modifiedAt, NOW, settings))
      .filter((bucket) => bucket !== null);
    expect(new Set(buckets).size, context).toBe(buckets.length);

    // What it kept, it keeps.
    expect(thinVersions({ versions: kept, now: NOW, settings }), context).toEqual([]);
  });
});

describe('one version per editing session', () => {
  const history = (overrides = {}) => ({
    currentSession: 'doc-key',
    currentExplicit: false,
    sessionCheckpointAt: new Date(NOW - 2 * MINUTE_MS).toISOString(),
    ...overrides,
  });
  const decide = (overrides = {}) =>
    sessionDecision({
      history: history(),
      fingerprintMatches: true,
      session: { key: 'doc-key' },
      now: NOW,
      checkpointMinutes: 10,
      ...overrides,
    });

  it('lets an automatic save inside the session overwrite without a version', () => {
    expect(decide()).toBe('skip');
  });

  it('keeps the document as it was before the session started', () => {
    expect(decide({ session: { key: 'another-session' } })).toBe('keep');
    expect(decide({ history: null })).toBe('keep');
  });

  it('keeps a checkpoint once the session has run long enough since the last one', () => {
    expect(
      decide({
        history: history({ sessionCheckpointAt: new Date(NOW - 10 * MINUTE_MS).toISOString() }),
      })
    ).toBe('keep');
    expect(decide({ checkpointMinutes: 1 })).toBe('keep');
  });

  it('keeps what someone saved on purpose when the next save comes', () => {
    expect(decide({ history: history({ currentExplicit: true }) })).toBe('keep');
  });

  it('keeps content that changed outside the application', () => {
    expect(decide({ fingerprintMatches: false })).toBe('keep');
  });

  it('keeps every save that belongs to no session, as the text editor makes them', () => {
    expect(decide({ session: null })).toBe('keep');
    expect(decide({ session: { key: null } })).toBe('keep');
  });

  it('keeps a version when the session never recorded a checkpoint', () => {
    expect(decide({ history: history({ sessionCheckpointAt: null }) })).toBe('keep');
  });
});

describe('a save from before a restore', () => {
  const restoredAt = new Date(NOW).toISOString();

  it('is stale when its session started before the restore', () => {
    expect(isStaleSave({ history: { restoredAt }, session: { startedAt: NOW - 5000 } })).toBe(true);
  });

  it('is not stale when the session started after it, or in the same second', () => {
    expect(isStaleSave({ history: { restoredAt }, session: { startedAt: NOW + 3000 } })).toBe(
      false
    );
    expect(isStaleSave({ history: { restoredAt }, session: { startedAt: NOW + 400 } })).toBe(false);
  });

  it('is never stale without a restore or without a known start', () => {
    expect(isStaleSave({ history: { restoredAt: null }, session: { startedAt: NOW } })).toBe(false);
    expect(isStaleSave({ history: { restoredAt }, session: {} })).toBe(false);
    expect(isStaleSave({ history: { restoredAt }, session: { startedAt: null } })).toBe(false);
    expect(isStaleSave({ history: null, session: { startedAt: NOW } })).toBe(false);
  });
});

describe('a zone shared by the trash and file versions', () => {
  const item = (id, daysAgo, size = 1) => ({ id, size, deletedAt: NOW - daysAgo * DAY_MS });
  const fileVersion = (id, fileId, daysAgo, extra = {}) => ({
    id,
    fileId,
    size: 1,
    modifiedAt: NOW - daysAgo * DAY_MS,
    ...extra,
  });
  const zone = (items, versions, overrides = {}) =>
    planZone({
      items,
      versions,
      now: NOW,
      retentionDays: 30,
      budgetBytes: Infinity,
      freeBytes: Infinity,
      floorBytes: 0,
      ...overrides,
    });

  it('lets expired versions go whatever the space, and does not call it an eviction', () => {
    const result = zone(
      [],
      [fileVersion('a', 'f', 1, { expired: 'thinned' }), fileVersion('b', 'f', 0)]
    );
    expect(result.purgeVersions).toEqual([{ id: 'a', reason: 'thinned', early: false }]);
    expect(result.usedAfter).toBe(1);
  });

  it('evicts older versions first, then the trash, then the latest version of each file, then pinned ones', () => {
    const items = [item('trash-old', 5), item('trash-new', 1)];
    const versions = [
      fileVersion('pinned', 'f1', 50, { pinned: true }),
      fileVersion('f1-latest', 'f1', 2),
      fileVersion('f1-older', 'f1', 9),
      fileVersion('f2-latest', 'f2', 20),
      fileVersion('f2-older', 'f2', 30),
    ];
    const order = (budgetBytes) => {
      const result = zone(items, versions, { budgetBytes });
      return [
        ...result.purgeVersions.map((entry) => entry.id),
        ...result.purge.map((entry) => entry.id),
      ];
    };
    expect(order(5)).toEqual(['f2-older', 'f1-older']);
    const everything = zone(items, versions, { budgetBytes: 0 });
    expect(everything.purgeVersions.map((entry) => entry.id)).toEqual([
      'f2-older',
      'f1-older',
      'f2-latest',
      'f1-latest',
      'pinned',
    ]);
    expect(everything.purge.map((entry) => entry.id)).toEqual(['trash-old', 'trash-new']);
    expect(
      everything.purgeVersions.every((entry) => entry.early && entry.reason === 'budget')
    ).toBe(true);
    // The latest versions only go once the trash has nothing left to give.
    expect(zone(items, versions, { budgetBytes: 2 }).purge.map((entry) => entry.id)).toEqual([
      'trash-old',
      'trash-new',
    ]);
    expect(
      zone(items, versions, { budgetBytes: 2 }).purgeVersions.map((entry) => entry.id)
    ).toEqual(['f2-older', 'f1-older', 'f2-latest']);
  });

  it('gives space back to a volume under its floor, and says so', () => {
    const result = zone([], [fileVersion('a', 'f', 3), fileVersion('b', 'f', 1)], {
      freeBytes: 0,
      floorBytes: 1,
    });
    expect(result.purgeVersions).toEqual([{ id: 'a', reason: 'space', early: true }]);
  });

  it.each(seedsFor(100, 900))(
    'decides exactly as the trash alone did when there are no versions (seed %i)',
    (seed) => {
      const random = createRandom(seed);
      const items = Array.from({ length: random.int(0, 30) }, (_, index) =>
        item(`i${index}`, random.int(0, 60), random.int(0, 100))
      );
      const input = {
        items,
        now: NOW,
        retentionDays: random.int(1, 40),
        budgetBytes: random.chance(0.2) ? Infinity : random.int(0, 1500),
        freeBytes: random.chance(0.2) ? null : random.int(0, 500),
        floorBytes: random.int(0, 300),
      };
      const alone = planMaintenance(input);
      const shared = planZone({ ...input, versions: [] });
      expect({
        purge: shared.purge,
        usedAfter: shared.usedAfter,
        freeAfter: shared.freeAfter,
      }).toEqual(alone);
      expect(shared.purgeVersions).toEqual([]);
    }
  );
});
