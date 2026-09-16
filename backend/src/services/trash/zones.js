/**
 * The reserved spaces the trash lives in.
 *
 * Deleting must be a rename, never a copy: a forty-gigabyte folder goes to the
 * trash as fast as a one-kilobyte file, and no space is needed at the moment
 * it happens. A rename only works within one filesystem, so the trash cannot
 * be a single folder somewhere — it is a hidden directory at the root of each
 * space a file can be deleted from:
 *
 *   - a volume: `<VOLUME_ROOT>/<volume>/.nextexplorer`
 *   - a personal folder: `<USER_ROOT>/<folder>/.nextexplorer`
 *   - a volume assigned to a user outside the volume root:
 *     `<its path>/.nextexplorer`
 *
 * The zone is located from the absolute path alone, whatever logical path —
 * a volume, a user volume label, a share — the deletion came through, so one
 * physical tree always has one zone.
 *
 * Each zone carries a marker naming it. The maintenance pass only acts on a
 * zone whose marker is there and names the zone it expects: an unmounted disk
 * looks exactly like an emptied one from here, and only the marker tells them
 * apart.
 */
const fsp = require('fs/promises');
const path = require('path');

const { directories } = require('../../config/index');
const { ZONE_DIRECTORY_NAME } = require('../../config/constants');
const { generateId } = require('../../utils/ids');
const { getDb } = require('../db');
const clock = require('./clock');
const store = require('./store');

const TRASH_DIRECTORY = 'trash';
const VERSIONS_DIRECTORY = 'versions';
const MARKER_FILE = 'zone.json';

const zoneDirectory = (root) => path.join(root, ZONE_DIRECTORY_NAME);
const trashDirectory = (root) => path.join(root, ZONE_DIRECTORY_NAME, TRASH_DIRECTORY);
/** Earlier contents of files, one file per version, named by the version's id. */
const versionsDirectory = (root) => path.join(root, ZONE_DIRECTORY_NAME, VERSIONS_DIRECTORY);
const markerPath = (root) => path.join(root, ZONE_DIRECTORY_NAME, MARKER_FILE);

const isWithin = (parent, candidate) =>
  candidate === parent ||
  candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const firstSegmentUnder = (parent, candidate) =>
  path.join(parent, path.relative(parent, candidate).split(path.sep)[0]);

const userVolumePaths = async () => {
  const db = await getDb();
  try {
    return db
      .prepare('SELECT DISTINCT path FROM user_volumes')
      .all()
      .map((row) => path.resolve(row.path))
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The root of the zone an absolute path belongs to, or the reason there is
 * none: `zone-root` for the root itself (a volume cannot be put in its own
 * trash), `inside-zone` for something already in one, `no-zone` for a path
 * outside every space the application manages.
 */
const locateZoneRoot = async (absolutePath) => {
  const target = path.resolve(absolutePath);
  let root;

  // The personal root first: by default it sits inside the volume root.
  if (isWithin(directories.userRoot, target) && target !== directories.userRoot) {
    root = firstSegmentUnder(directories.userRoot, target);
  } else if (isWithin(directories.volume, target) && target !== directories.volume) {
    root = firstSegmentUnder(directories.volume, target);
  } else {
    // The outermost assigned volume containing the path, so that two labels
    // over nested folders still share one zone.
    const containing = (await userVolumePaths())
      .filter((volumePath) => isWithin(volumePath, target))
      .sort((left, right) => left.length - right.length);
    root = containing[0] || null;
  }

  if (!root) return { reason: 'no-zone' };
  if (target === root) return { reason: 'zone-root' };
  if (isWithin(zoneDirectory(root), target)) return { reason: 'inside-zone' };
  return { root };
};

/** The device a path lives on, without following a final symbolic link. */
const deviceOf = async (absolutePath) => (await fsp.lstat(absolutePath)).dev;

/**
 * Whether two paths share a device. Called through the module so a test can
 * stand in for a second disk where the machine has none.
 */
const sameDevice = async (left, right) => {
  const [a, b] = await Promise.all([module.exports.deviceOf(left), module.exports.deviceOf(right)]);
  return a === b;
};

const readMarker = async (root) => {
  let raw;
  try {
    raw = await fsp.readFile(markerPath(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'string' && parsed.id ? parsed : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
};

/**
 * Open the zone at `root`, creating it if it does not exist yet. Only called
 * while deleting something that exists under `root`, which is what proves the
 * volume is mounted: a zone is never created on the strength of a path alone.
 *
 * A marker already on disk wins over the database. A zone whose rows were lost
 * — a database restored from an older backup — is taken back as the zone it
 * says it is.
 */
const ensureZone = async (root) => {
  await fsp.mkdir(trashDirectory(root), { recursive: true, mode: 0o700 });

  let marker = await readMarker(root);
  if (!marker) {
    const created = { id: generateId(), createdAt: clock.nowIso() };
    try {
      // Exclusive: two deletions racing to create the zone agree on one id.
      await fsp.writeFile(markerPath(root), `${JSON.stringify(created)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      marker = created;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      marker = await readMarker(root);
    }
  }
  if (!marker || marker.corrupt) {
    const error = new Error(`The trash marker in ${zoneDirectory(root)} is unreadable.`);
    error.code = 'TRASH_ZONE_UNREADABLE';
    throw error;
  }

  const db = await getDb();
  store.insertZone(db, { id: marker.id, root, createdAt: marker.createdAt });
  return { id: marker.id, root, trashDirectory: trashDirectory(root) };
};

/**
 * Whether a zone the database knows is there to act on: its marker present and
 * naming it. Anything else — a disk not mounted yet, a different disk mounted
 * in its place, a zone removed by hand — is reported and left alone.
 */
const inspectZone = async (zone) => {
  let marker;
  try {
    marker = await readMarker(zone.root);
  } catch {
    return { available: false, reason: 'unreadable' };
  }
  if (!marker) return { available: false, reason: 'missing' };
  if (marker.corrupt) return { available: false, reason: 'unreadable' };
  if (marker.id !== zone.id) return { available: false, reason: 'replaced' };
  return { available: true };
};

/** Where an item's content and its description sit in a zone. */
const itemPaths = (root, itemId) => ({
  payload: path.join(trashDirectory(root), itemId),
  sidecar: path.join(trashDirectory(root), `${itemId}.json`),
});

/** What a zone is, in words a person recognises: a volume, a personal folder, an assigned volume. */
const describeZoneRoot = (root) => {
  if (isWithin(directories.userRoot, root)) return { kind: 'personal', name: path.basename(root) };
  if (isWithin(directories.volume, root)) return { kind: 'volume', name: path.basename(root) };
  return { kind: 'user-volume', name: path.basename(root) };
};

module.exports = {
  TRASH_DIRECTORY,
  VERSIONS_DIRECTORY,
  MARKER_FILE,
  zoneDirectory,
  trashDirectory,
  versionsDirectory,
  markerPath,
  isWithin,
  locateZoneRoot,
  deviceOf,
  sameDevice,
  ensureZone,
  inspectZone,
  itemPaths,
  describeZoneRoot,
};
