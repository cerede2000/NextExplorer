/**
 * The pass that keeps each zone within its promises.
 *
 * For every zone the database knows, in turn:
 *   1. recover — finish or undo what a crash interrupted, adopt what has no
 *      record, and touch nothing at all if the zone's marker is not there;
 *   2. plan — the policy decides what has reached its retention and what must
 *      go to bring the zone within its budget and the volume above its floor;
 *   3. purge — one item at a time, each failure isolated and recorded, so one
 *      item that cannot be removed never stops the others from expiring.
 *
 * It runs at startup, every hour, shortly after a deletion that may have pushed
 * a zone over its budget, and on demand when an upload needs the space. One
 * pass at a time: a request arriving during a pass runs another after it,
 * rather than being answered by a pass that started before it.
 */
const fsp = require('fs/promises');

const config = require('../../config/index');
const logger = require('../../utils/logger');
const { getDb } = require('../db');
const clock = require('./clock');
const operations = require('./operations');
const policy = require('./policy');
const store = require('./store');
const { getTrashSettings } = require('./settings');
const zones = require('./zones');

const PASS_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_DELAY_MS = 1000;

let interval = null;
let requested = null;
let running = null;
let again = false;
let stopped = true;
const lastPasses = new Map();

/** Capacity and free space of the filesystem holding `root`, or nulls when it cannot be measured. */
const measureVolume = async (root) => {
  try {
    const stats = await fsp.statfs(root);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
};

/** The budget, free space and floor a zone is held to. */
const limitsFor = async (root, settings) => {
  const { totalBytes, freeBytes } = await module.exports.measureVolume(root);
  return {
    totalBytes,
    freeBytes,
    budgetBytes: policy.budgetFor({
      totalBytes,
      maxPercent: settings.maxPercent,
      maxBytes: settings.maxBytes,
    }),
    floorBytes: config.upload?.storageReserveBytes ?? 0,
  };
};

const trashedItemsOf = (db, zone) =>
  store
    .listItemsByZone(db, zone.id)
    .filter((item) => item.state === 'trashed' && !operations.inflight.has(item.id))
    .map((item) => ({ ...item, deletedAtMs: Date.parse(item.deletedAt) }));

/**
 * Purge what a plan names, one item at a time. Returns what happened, and stops
 * early only when the zone itself stops being reachable.
 */
const applyPlan = async (db, zone, plan, itemsById) => {
  const outcome = { purged: 0, purgedBytes: 0, evictedEarly: 0, failed: 0 };
  for (const entry of plan) {
    const item = itemsById.get(entry.id);
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await operations.purgeItem(entry.id);
      if (result.status === 'unavailable') break;
      if (result.status !== 'purged') continue;
      outcome.purged += 1;
      outcome.purgedBytes += result.item.size;
      if (entry.early) {
        outcome.evictedEarly += 1;
        store.insertEvent(db, {
          zoneId: zone.id,
          itemId: entry.id,
          itemName: result.item.name,
          kind: 'evicted',
          detail: JSON.stringify({ reason: entry.reason, deletedAt: result.item.deletedAt }),
        });
      }
    } catch (error) {
      outcome.failed += 1;
      store.insertEvent(db, {
        zoneId: zone.id,
        itemId: entry.id,
        itemName: item?.name || null,
        kind: 'failed',
        detail: error?.message || String(error),
      });
      logger.warn(
        { err: error, zoneId: zone.id, itemId: entry.id },
        'A trash item could not be purged'
      );
    }
  }
  return outcome;
};

/** One zone's pass. `floorBytes` raises the free space the volume must keep, for an upload waiting on it. */
const maintainZone = async (zone, settings, { floorBytes = null } = {}) => {
  const summary = {
    zoneId: zone.id,
    root: zone.root,
    at: clock.nowIso(),
    available: true,
    purged: 0,
    purgedBytes: 0,
    evictedEarly: 0,
    failed: 0,
  };

  const recovery = await operations.recoverZone(zone);
  if (recovery.skipped) {
    return { ...summary, available: false, reason: recovery.reason };
  }
  summary.recovery = recovery;

  const db = await getDb();
  const items = trashedItemsOf(db, zone);
  const limits = await limitsFor(zone.root, settings);
  const plan = policy.planMaintenance({
    items: items.map((item) => ({ id: item.id, size: item.size, deletedAt: item.deletedAtMs })),
    now: clock.now(),
    retentionDays: settings.retentionDays,
    budgetBytes: limits.budgetBytes,
    freeBytes: limits.freeBytes,
    floorBytes: Math.max(limits.floorBytes, floorBytes ?? 0),
  });

  const outcome = await applyPlan(
    db,
    zone,
    plan.purge,
    new Map(items.map((item) => [item.id, item]))
  );
  return { ...summary, ...outcome, budgetBytes: limits.budgetBytes };
};

const runOnce = async ({ reason }) => {
  const settings = await getTrashSettings();
  const db = await getDb();
  const results = [];
  for (const zone of store.listZones(db)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const summary = await maintainZone(zone, settings);
      lastPasses.set(zone.id, summary);
      results.push(summary);
      if (!summary.available) {
        logger.warn(
          { zoneId: zone.id, root: zone.root, reason: summary.reason },
          'A trash zone is not there; nothing in it was touched'
        );
      } else if (summary.purged || summary.failed) {
        logger.info(
          {
            zoneId: zone.id,
            root: zone.root,
            purged: summary.purged,
            evictedEarly: summary.evictedEarly,
            failed: summary.failed,
            reason,
          },
          'Trash maintenance'
        );
      }
    } catch (error) {
      const summary = {
        zoneId: zone.id,
        root: zone.root,
        at: clock.nowIso(),
        error: error.message,
      };
      lastPasses.set(zone.id, summary);
      results.push(summary);
      logger.warn({ err: error, zoneId: zone.id }, 'Trash maintenance failed for a zone');
    }
  }
  return results;
};

/** Run a pass now. A call during a pass waits for it, then runs one more. */
const runPass = async ({ reason = 'manual' } = {}) => {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let results;
    do {
      again = false;
      // eslint-disable-next-line no-await-in-loop
      results = await runOnce({ reason });
    } while (again);
    return results;
  })().finally(() => {
    running = null;
  });
  return running;
};

/** Ask for a pass soon, collapsing a burst of deletions into one. */
const requestPass = ({ delayMs = REQUEST_DELAY_MS } = {}) => {
  if (requested) return;
  requested = setTimeout(() => {
    requested = null;
    runPass({ reason: 'requested' }).catch((error) =>
      logger.warn({ err: error }, 'Requested trash maintenance failed')
    );
  }, delayMs);
  requested.unref?.();
};

/** Resolves once no pass is scheduled or running. */
const idle = async () => {
  while (requested || running) {
    // eslint-disable-next-line no-await-in-loop
    await (running || new Promise((resolve) => setTimeout(resolve, 5)));
  }
};

/**
 * Give an upload the space it needs, from the trash of the volume it is going
 * to, before it is refused. Returns the bytes freed.
 */
const makeRoom = async (directory, requiredBytes) => {
  const located = await zones.locateZoneRoot(directory);
  // A volume's own root has no zone above it; it is the zone's root.
  const root = located.root || (located.reason === 'zone-root' ? directory : null);
  if (!root || !Number.isFinite(requiredBytes)) return 0;

  const settings = await getTrashSettings();
  const db = await getDb();
  let freed = 0;
  for (const zone of store.listZones(db).filter((candidate) => candidate.root === root)) {
    // Emptying a trash for an upload that would be refused anyway destroys
    // people's deleted files for nothing: only when the trash can cover the
    // shortfall is anything purged.
    // eslint-disable-next-line no-await-in-loop
    const { freeBytes } = await module.exports.measureVolume(root);
    const held = trashedItemsOf(db, zone).reduce((total, item) => total + item.size, 0);
    if (Number.isFinite(freeBytes) && freeBytes + held < requiredBytes) continue;
    // eslint-disable-next-line no-await-in-loop
    const summary = await maintainZone(zone, settings, { floorBytes: requiredBytes });
    freed += summary.purgedBytes || 0;
  }
  return freed;
};

/** Every zone, what it holds, what it may hold, and what the last pass found. */
const zonesOverview = async () => {
  const settings = await getTrashSettings();
  const db = await getDb();
  const overview = [];
  for (const zone of store.listZones(db)) {
    // eslint-disable-next-line no-await-in-loop
    const inspection = await zones.inspectZone(zone);
    const items = store.listItemsByZone(db, zone.id);
    // eslint-disable-next-line no-await-in-loop
    const limits = inspection.available ? await limitsFor(zone.root, settings) : null;
    overview.push({
      id: zone.id,
      ...zones.describeZoneRoot(zone.root),
      available: inspection.available,
      reason: inspection.reason || null,
      itemCount: items.length,
      usedBytes: items.reduce((total, item) => total + item.size, 0),
      budgetBytes: limits && Number.isFinite(limits.budgetBytes) ? limits.budgetBytes : null,
      freeBytes: limits?.freeBytes ?? null,
      lastPass: lastPasses.get(zone.id) || null,
      events: store.listEvents(db, { zoneId: zone.id, limit: 20 }),
    });
  }
  return overview;
};

const start = () => {
  if (interval) return;
  stopped = false;
  runPass({ reason: 'startup' }).catch((error) =>
    logger.warn({ err: error }, 'Trash maintenance at startup failed')
  );
  interval = setInterval(() => {
    if (stopped) return;
    runPass({ reason: 'scheduled' }).catch((error) =>
      logger.warn({ err: error }, 'Scheduled trash maintenance failed')
    );
  }, PASS_INTERVAL_MS);
  interval.unref?.();
};

const stop = () => {
  stopped = true;
  if (interval) clearInterval(interval);
  interval = null;
  if (requested) clearTimeout(requested);
  requested = null;
};

module.exports = {
  PASS_INTERVAL_MS,
  measureVolume,
  limitsFor,
  maintainZone,
  runPass,
  requestPass,
  idle,
  makeRoom,
  zonesOverview,
  start,
  stop,
};
