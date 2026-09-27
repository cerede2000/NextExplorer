/**
 * Whether a zone's versions and its disk agree.
 *
 * Part of the zone's oracle: `verifyZone` adds these to the trash's own
 * invariants, so every test, the maintenance and the administrator's "Verify"
 * button check both at once. It reads and reports, and repairs nothing.
 *
 *   I2  a kept version has its content, and every content has its version
 *   I3  a history in the trash belongs to an item that is there
 *   I4  no version and no history is left in a passing state
 *   I8  the size recorded is the size on disk
 */
const fsp = require('fs/promises');
const path = require('path');

const { getDb } = require('../db');
const trashStore = require('../trash/store');
const zones = require('../trash/zones');
const operations = require('./operations');
const store = require('./store');

const verifyVersions = async (zone, { measureSizes = true } = {}) => {
  const db = await getDb();
  const violations = [];
  const directory = zones.versionsDirectory(zone.root);
  let names;
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    names = [];
  }
  const onDisk = new Set(names);
  const rows = store.listVersionsInZone(db, zone.id);
  const known = new Set(rows.map((row) => row.id));
  let versionBytes = 0;
  let versionCount = 0;

  for (const row of rows) {
    if (operations.inflight.has(row.id)) continue;
    if (row.state !== 'kept') {
      violations.push({ invariant: 'I4', versionId: row.id, detail: `left in state ${row.state}` });
      continue;
    }
    versionCount += 1;
    versionBytes += row.size;
    if (!onDisk.has(row.id)) {
      violations.push({ invariant: 'I2', versionId: row.id, detail: 'content missing' });
      continue;
    }
    if (measureSizes) {
      const stats = await fsp.lstat(path.join(directory, row.id));
      if (stats.size !== row.size) {
        violations.push({
          invariant: 'I8',
          versionId: row.id,
          detail: `recorded ${row.size} bytes, found ${stats.size}`,
        });
      }
    }
  }

  for (const name of names) {
    if (known.has(name) || operations.inflight.has(name)) continue;
    if (!operations.VERSION_ID_PATTERN.test(name)) continue;
    violations.push({ invariant: 'I2', versionId: name, detail: 'content without a version' });
  }

  for (const file of store.listFiles(db, { zoneId: zone.id })) {
    if (file.state === 'purging') {
      violations.push({ invariant: 'I4', fileId: file.id, detail: 'history left purging' });
    } else if (file.state === 'trashed') {
      const item = file.trashItemId ? trashStore.getItem(db, file.trashItemId) : null;
      if (!item) {
        violations.push({
          invariant: 'I3',
          fileId: file.id,
          detail: 'history in the trash without its item',
        });
      }
    } else if (!['live', 'orphaned'].includes(file.state)) {
      violations.push({ invariant: 'I3', fileId: file.id, detail: `unknown state ${file.state}` });
    }
  }

  return { violations, versionBytes, versionCount };
};

module.exports = { verifyVersions };
