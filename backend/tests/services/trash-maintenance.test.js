import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The maintenance pass: what keeps the trash's promises over time.
 *
 * The hour is injected and the volume's size stood in for, so a month of
 * retention or a nearly full disk is one line of setup. Every test that
 * changes a zone ends on the oracle.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);

let envContext;
let operations;
let maintenance;
let store;
let zones;
let clock;
let failpoints;
let verify;
let settingsService;
let db;
let now;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'trash-maintenance-',
    env: { UPLOAD_STORAGE_RESERVE: '0' },
  });
  clock = load('src/services/trash/clock');
  zones = load('src/services/trash/zones');
  store = load('src/services/trash/store');
  failpoints = load('src/services/trash/failpoints');
  operations = load('src/services/trash/operations');
  maintenance = load('src/services/trash/maintenance');
  verify = load('src/services/trash/verify');
  settingsService = load('src/services/settingsService');
  db = await load('src/services/db').getDb();
  now = T0;
  vi.spyOn(clock, 'now').mockImplementation(() => now);
  // A roomy disk unless a test says otherwise.
  vi.spyOn(maintenance, 'measureVolume').mockResolvedValue({
    totalBytes: 10_000_000,
    freeBytes: 10_000_000,
  });
  // config/index is a singleton the pass reads by reference; a test that raised
  // the free-space floor would otherwise leave it raised for the next. Start
  // each test with no floor, so only the ones that set one feel it.
  load('src/config/index').uploads.storageReserveBytes = 0;
});

afterEach(async () => {
  failpoints.clear();
  vi.restoreAllMocks();
  await envContext.cleanup();
});

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

const trashAt = async (relative, { daysAgo = 0, content = 'x' } = {}) => {
  const previous = now;
  now = T0 - daysAgo * DAY;
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
  const result = await operations.moveToTrash({ absolutePath: volume(relative) });
  now = previous;
  return result.item;
};

const zoneOf = () => store.listZones(db).find((zone) => zone.root === volume('Projects'));
const remaining = () =>
  store
    .listItemsByZone(db, zoneOf().id)
    .map((item) => item.name)
    .sort();
const eventsOf = () => store.listEvents(db, { zoneId: zoneOf().id });

const expectConsistent = async () => {
  expect((await verify.verifyZone(zoneOf())).violations).toEqual([]);
};

describe('the retention', () => {
  it('lets go of what has been kept thirty days, and nothing younger', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 31 });
    await trashAt('Projects/recent.txt', { daysAgo: 29 });

    const [summary] = await maintenance.runPass();

    expect(summary).toMatchObject({ available: true, purged: 1, evictedEarly: 0, failed: 0 });
    expect(remaining()).toEqual(['recent.txt']);
    await expectConsistent();
  });

  it('follows the retention an administrator set', async () => {
    await settingsService.setSystemSetting('system', 'trash', { retentionDays: 7 });
    await trashAt('Projects/week-old.txt', { daysAgo: 8 });

    await maintenance.runPass();

    expect(remaining()).toEqual([]);
  });

  /** Switching the trash off stops new deletions going to it, not the old ones expiring. */
  it('still expires what is there when the trash is switched off', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 40 });
    await settingsService.setSystemSetting('system', 'trash', { enabled: false });

    await maintenance.runPass();

    expect(remaining()).toEqual([]);
  });

  it('does not record an expiry as an early eviction', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 31 });

    await maintenance.runPass();

    expect(eventsOf().filter((event) => event.kind === 'evicted')).toEqual([]);
  });
});

describe('the budget', () => {
  it('evicts the oldest first until the zone fits, and records each one', async () => {
    // 10 % of 100 bytes: the zone may hold 10.
    maintenance.measureVolume.mockResolvedValue({ totalBytes: 100, freeBytes: 1_000_000 });
    await trashAt('Projects/a.txt', { daysAgo: 3, content: '123456' });
    await trashAt('Projects/b.txt', { daysAgo: 2, content: '123456' });
    await trashAt('Projects/c.txt', { daysAgo: 1, content: '123456' });

    const [summary] = await maintenance.runPass();

    expect(summary).toMatchObject({ purged: 2, evictedEarly: 2, budgetBytes: 10 });
    expect(remaining()).toEqual(['c.txt']);
    expect(
      eventsOf().map((event) => [event.kind, event.itemName, JSON.parse(event.detail).reason])
    ).toEqual([
      ['evicted', 'b.txt', 'budget'],
      ['evicted', 'a.txt', 'budget'],
    ]);
    await expectConsistent();
  });

  it('holds the configured size when it is smaller than the share', async () => {
    await settingsService.setSystemSetting('system', 'trash', { maxBytes: 7 });
    await trashAt('Projects/a.txt', { daysAgo: 2, content: '1234' });
    await trashAt('Projects/b.txt', { daysAgo: 1, content: '1234' });

    await maintenance.runPass();

    expect(remaining()).toEqual(['b.txt']);
  });

  /** The disk filling up for another reason: the trash gives space back before anything is refused. */
  it('gives space back when the volume falls under its floor', async () => {
    maintenance.measureVolume.mockResolvedValue({ totalBytes: 1_000_000, freeBytes: 2 });
    // The same configuration object the pass holds: reloading it would give the
    // test a copy the pass never reads.
    load('src/config/index').uploads.storageReserveBytes = 5;
    await trashAt('Projects/a.txt', { daysAgo: 2, content: '1234' });
    await trashAt('Projects/b.txt', { daysAgo: 1, content: '1234' });

    const [summary] = await maintenance.runPass();

    expect(summary.purged).toBe(1);
    expect(remaining()).toEqual(['b.txt']);
    expect(JSON.parse(eventsOf()[0].detail).reason).toBe('space');
  });
});

describe('what the pass never does', () => {
  it('touches nothing in a zone whose marker is gone, even what has expired', async () => {
    const item = await trashAt('Projects/old.txt', { daysAgo: 90 });
    await fs.rm(zones.markerPath(volume('Projects')));

    const [summary] = await maintenance.runPass();

    expect(summary).toMatchObject({ available: false, reason: 'missing', purged: 0 });
    expect(store.getItem(db, item.id)).not.toBeNull();
    expect(await fs.readFile(zones.itemPaths(volume('Projects'), item.id).payload, 'utf8')).toBe(
      'x'
    );
  });

  it('lets one item that cannot be purged hold nothing else back, and finishes it next time', async () => {
    const stuck = await trashAt('Projects/stuck.txt', { daysAgo: 40 });
    await trashAt('Projects/other.txt', { daysAgo: 40 });
    failpoints.set('purge:after-remove', ({ id }) => {
      if (id === stuck.id) throw new Error('the disk said no');
    });

    const [first] = await maintenance.runPass();

    expect(first).toMatchObject({ purged: 1, failed: 1 });
    expect(eventsOf()[0]).toMatchObject({
      kind: 'failed',
      itemName: 'stuck.txt',
      detail: 'the disk said no',
    });

    failpoints.clear();
    await maintenance.runPass();

    expect(remaining()).toEqual([]);
    await expectConsistent();
  });

  it('does nothing the second time', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 40 });
    await trashAt('Projects/recent.txt', { daysAgo: 1 });
    await maintenance.runPass();

    const [second] = await maintenance.runPass();

    expect(second).toMatchObject({ purged: 0, failed: 0 });
    expect(remaining()).toEqual(['recent.txt']);
  });

  it('never runs two passes over each other', async () => {
    for (let index = 0; index < 5; index += 1) {
      await trashAt(`Projects/old-${index}.txt`, { daysAgo: 40 });
    }

    const results = await Promise.all([
      maintenance.runPass(),
      maintenance.runPass(),
      maintenance.runPass(),
    ]);

    const failed = results.flat().reduce((total, summary) => total + (summary.failed || 0), 0);
    expect(failed).toBe(0);
    expect(remaining()).toEqual([]);
    await expectConsistent();
  });
});

describe('recovery during the pass', () => {
  it('finishes a deletion a crash interrupted', async () => {
    await fs.mkdir(volume('Projects'), { recursive: true });
    await fs.writeFile(volume('Projects/report.txt'), 'x');
    failpoints.set('trash:after-rename', () => failpoints.crash('trash:after-rename'));
    await expect(
      operations.moveToTrash({ absolutePath: volume('Projects/report.txt') })
    ).rejects.toThrow();
    failpoints.clear();

    await maintenance.runPass();

    const [item] = store.listItemsByZone(db, zoneOf().id);
    expect(item.state).toBe('trashed');
    await expectConsistent();
  });
});

describe('making room for an upload', () => {
  it('purges the oldest items of the destination volume until the upload fits', async () => {
    maintenance.measureVolume.mockResolvedValue({ totalBytes: 1_000_000, freeBytes: 3 });
    await trashAt('Projects/a.txt', { daysAgo: 3, content: '1234' });
    await trashAt('Projects/b.txt', { daysAgo: 2, content: '1234' });
    await trashAt('Projects/c.txt', { daysAgo: 1, content: '1234' });

    const freed = await maintenance.makeRoom(volume('Projects', 'uploads'), 10);

    expect(freed).toBe(8);
    expect(remaining()).toEqual(['c.txt']);
  });

  it('leaves other volumes alone', async () => {
    maintenance.measureVolume.mockResolvedValue({ totalBytes: 1_000_000, freeBytes: 0 });
    await trashAt('Projects/a.txt', { daysAgo: 3, content: '1234' });
    await fs.mkdir(volume('Photos'), { recursive: true });

    expect(await maintenance.makeRoom(volume('Photos'), 10)).toBe(0);
    expect(remaining()).toEqual(['a.txt']);
  });
});

describe('the overview', () => {
  it('says what each zone holds, may hold, and what the last pass found', async () => {
    maintenance.measureVolume.mockResolvedValue({ totalBytes: 1000, freeBytes: 500 });
    await trashAt('Projects/a.txt', { daysAgo: 1, content: '12345' });
    await maintenance.runPass();

    const [zone] = await maintenance.zonesOverview();

    expect(zone).toMatchObject({
      kind: 'volume',
      name: 'Projects',
      available: true,
      itemCount: 1,
      usedBytes: 5,
      budgetBytes: 100,
      freeBytes: 500,
      lastPass: { available: true, purged: 0 },
    });
  });

  it('says a zone is not there without measuring anything', async () => {
    await trashAt('Projects/a.txt', { daysAgo: 1 });
    await fs.rm(zones.markerPath(volume('Projects')));

    const [zone] = await maintenance.zonesOverview();

    expect(zone).toMatchObject({ available: false, reason: 'missing', budgetBytes: null });
  });
});

describe('a requested pass', () => {
  it('runs shortly after it is asked for, however many times it is asked', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 40 });

    maintenance.requestPass({ delayMs: 1 });
    maintenance.requestPass({ delayMs: 1 });
    await maintenance.idle();

    expect(remaining()).toEqual([]);
    await expectConsistent();
  });

  it('runs nothing once stopped', async () => {
    await trashAt('Projects/old.txt', { daysAgo: 40 });

    maintenance.requestPass({ delayMs: 1 });
    maintenance.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await maintenance.idle();

    expect(remaining()).toEqual(['old.txt']);
  });
});
