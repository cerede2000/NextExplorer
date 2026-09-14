/**
 * Whether a zone's books and its disk agree.
 *
 * One function checks the invariants the design promises, and it serves three
 * times: as the oracle every trash test ends on, as the maintenance pass's
 * own check, and behind the administrator's "Verify" button. It reads and
 * reports; it never repairs — that is the recovery's job, and a check that
 * quietly fixed what it found would hide the bugs it exists to reveal.
 *
 *   I1  an item in the trash has its content and its description, and every
 *       content in the zone has its item
 *   I4  no item is left in a passing state
 *   I5  after a pass, the zone fits its budget and the volume keeps its floor
 *   I8  the size recorded is the size on disk
 */
const fsp = require('fs/promises');

const { getDb } = require('../db');
const { verifyVersions } = require('../versions/verify');
const operations = require('./operations');
const store = require('./store');
const zones = require('./zones');

const verifyZone = async (
  zone,
  { budgetBytes, freeBytes, floorBytes, measureSizes = true } = {}
) => {
  const inspection = await zones.inspectZone(zone);
  if (!inspection.available) {
    return { zoneId: zone.id, available: false, reason: inspection.reason, violations: [] };
  }

  const db = await getDb();
  const violations = [];
  let names;
  try {
    names = await fsp.readdir(zones.trashDirectory(zone.root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    names = [];
  }
  const onDisk = new Set(names);
  const rows = store.listItemsByZone(db, zone.id);
  const known = new Set(rows.map((row) => row.id));
  let used = 0;
  let trashedCount = 0;

  for (const row of rows) {
    if (operations.inflight.has(row.id)) continue;
    if (row.state !== 'trashed') {
      violations.push({ invariant: 'I4', itemId: row.id, detail: `left in state ${row.state}` });
      continue;
    }
    trashedCount += 1;
    used += row.size;
    if (!onDisk.has(row.id)) {
      violations.push({ invariant: 'I1', itemId: row.id, detail: 'content missing' });
      continue;
    }
    if (!onDisk.has(`${row.id}.json`)) {
      violations.push({ invariant: 'I1', itemId: row.id, detail: 'description missing' });
    }
    if (measureSizes) {
      // eslint-disable-next-line no-await-in-loop
      const { bytes } = await operations.measure(zones.itemPaths(zone.root, row.id).payload);
      if (bytes !== row.size) {
        violations.push({
          invariant: 'I8',
          itemId: row.id,
          detail: `recorded ${row.size} bytes, found ${bytes}`,
        });
      }
    }
  }

  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
    if (known.has(id) || !operations.ITEM_ID_PATTERN.test(id)) continue;
    violations.push({
      invariant: 'I1',
      itemId: id,
      detail: name.endsWith('.json') ? 'description without an item' : 'content without an item',
    });
  }

  // The versions share the zone, its budget and this oracle.
  const versions = await verifyVersions(zone, { measureSizes });
  violations.push(...versions.violations);
  const held = used + versions.versionBytes;

  if (trashedCount > 0 || versions.versionCount > 0) {
    if (Number.isFinite(budgetBytes) && held > budgetBytes) {
      violations.push({
        invariant: 'I5',
        detail: `holds ${held} bytes over a ${budgetBytes} budget`,
      });
    }
    if (Number.isFinite(freeBytes) && Number.isFinite(floorBytes) && freeBytes < floorBytes) {
      violations.push({
        invariant: 'I5',
        detail: `${freeBytes} bytes free under a ${floorBytes} floor`,
      });
    }
  }

  return {
    zoneId: zone.id,
    available: true,
    usedBytes: used,
    itemCount: trashedCount,
    versionBytes: versions.versionBytes,
    versionCount: versions.versionCount,
    violations,
  };
};

module.exports = { verifyZone };
