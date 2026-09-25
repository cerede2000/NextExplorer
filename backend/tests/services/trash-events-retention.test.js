import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The trash's event log, bounded.
 *
 * Every purge, loss, breaker trip and version removal writes an event, and
 * nothing removed any: a zone whose retention empties something every day grew
 * the table for good. The maintenance pass now keeps a zone's newest events
 * and drops the rest, zone by zone.
 */

let envContext;
let operations;
let maintenance;
let store;
let db;

const load = (relative) => require(modulePath(relative));

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'trash-events-retention-',
    env: { UPLOAD_STORAGE_RESERVE: '0' },
  });
  store = load('src/services/trash/store');
  operations = load('src/services/trash/operations');
  maintenance = load('src/services/trash/maintenance');
  db = await load('src/services/db').getDb();
  // A roomy disk: the pass purges nothing, and writes no events of its own.
  vi.spyOn(maintenance, 'measureVolume').mockResolvedValue({
    totalBytes: 10_000_000,
    freeBytes: 10_000_000,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await envContext.cleanup();
});

const volume = (...segments) => path.join(envContext.volumeDir, ...segments);

/** A zone with something in its trash, so the pass visits it. */
const zoneWithTrash = async (folder) => {
  await fs.mkdir(volume(folder), { recursive: true });
  await fs.writeFile(volume(folder, 'old.txt'), 'x');
  await operations.moveToTrash({ absolutePath: volume(folder, 'old.txt') });
  return store.listZones(db).find((zone) => zone.root === volume(folder));
};

const logEvents = (zone, count) =>
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      store.insertEvent(db, { zoneId: zone.id, kind: 'purged', itemName: `file-${i}.txt` });
    }
  })();

const idsOf = (zone) =>
  db.prepare('SELECT id FROM trash_events WHERE zone_id = ? ORDER BY id DESC').pluck().all(zone.id);

describe('the trash event log', () => {
  it('keeps a zone’s newest events and drops the older ones', async () => {
    const zone = await zoneWithTrash('Projects');
    logEvents(zone, maintenance.EVENTS_KEPT_PER_ZONE + 25);
    const newest = idsOf(zone).slice(0, maintenance.EVENTS_KEPT_PER_ZONE);

    await maintenance.runPass({ reason: 'test' });

    expect(idsOf(zone)).toEqual(newest);
    // What the settings page shows is still there.
    expect(store.listEvents(db, { zoneId: zone.id, limit: 20 }).map((event) => event.id)).toEqual(
      newest.slice(0, 20)
    );
  });

  it('leaves a zone below the limit as it is', async () => {
    const zone = await zoneWithTrash('Projects');
    logEvents(zone, 30);
    const before = idsOf(zone);

    await maintenance.runPass({ reason: 'test' });

    expect(idsOf(zone)).toEqual(before);
  });

  it('counts each zone on its own', async () => {
    const busy = await zoneWithTrash('Projects');
    const quiet = await zoneWithTrash('Photos');
    expect(quiet.id).not.toBe(busy.id);
    logEvents(quiet, 10);
    logEvents(busy, maintenance.EVENTS_KEPT_PER_ZONE + 5);
    const quietBefore = idsOf(quiet);

    await maintenance.runPass({ reason: 'test' });

    expect(idsOf(busy)).toHaveLength(maintenance.EVENTS_KEPT_PER_ZONE);
    expect(idsOf(quiet)).toEqual(quietBefore);
  });
});
