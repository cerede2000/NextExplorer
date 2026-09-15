/**
 * Keeping what a save replaces, and letting it go.
 *
 * Every save the application makes over an existing file already writes the new
 * content beside it and renames it into place. Just before that rename, the old
 * content gets a second name inside the zone — a hard link, which copies
 * nothing — and the rename then replaces the file. At no instant is the path
 * empty for someone reading it over SMB, and the old content is afterwards
 * reachable from the zone alone. Where the filesystem refuses hard links, the
 * old file is renamed into the zone instead, leaving the path empty for the
 * microseconds between the two renames.
 *
 *   capture   row `capturing`, link (or rename) into the zone, new content
 *             renamed over the file, row `kept` with the file's new content
 *             recorded in the same transaction
 *   purge     row `purging`, content removed, row removed
 *
 * A crash between two steps leaves a row `recoverZone` knows how to settle, from
 * where the content actually is: a link that still shares the file's inode
 * means the new content never arrived, and the version is dropped.
 *
 * Whether a save deserves a version at all — one per editing session, never
 * the same content twice, never more than the zone could hold — is decided
 * before anything is touched. Who may ask is the service's business.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { generateId } = require('../../utils/ids');
const logger = require('../../utils/logger');
const { placeWithoutOverwrite } = require('../../utils/placeWithoutOverwrite');
const { getDb } = require('../db');
const { track: trackInFlight } = require('../inFlightFiles');
const clock = require('../trash/clock');
const failpoints = require('../trash/failpoints');
const { admission } = require('../trash/policy');
const trashStore = require('../trash/store');
const zones = require('../trash/zones');
const { isStaleSave, sessionDecision, thinVersions } = require('./policy');
const { getVersionSettings } = require('./settings');
const store = require('./store');

/** Versions with an operation running in this process; recovery leaves them alone. */
const inflight = new Set();

/** The names the application gives versions, as opposed to anything else in the directory. */
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{15,}$/;

/** Content found without a record is only removed once it is this old: a capture may be writing its row. */
const ORPHAN_CONTENT_GRACE_MS = 60 * 60 * 1000;

/** Errors a filesystem answers when it has no hard links to offer; the capture renames instead. */
const LINK_REFUSED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EACCES']);

const lstatOrNull = async (absolutePath) => {
  try {
    return await fsp.lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

const readdirOrEmpty = async (directory) => {
  try {
    return await fsp.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
};

/** The SHA-256 and length of a file, read as a stream. */
const hashFile = (absolutePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(absolutePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });

const toRelative = (root, absolutePath) =>
  path.relative(root, absolutePath).split(path.sep).join('/');

/**
 * Saves to one path, one at a time. Two editors saving the same document at
 * once would otherwise both link the same old content, and one of the two
 * versions would describe a state that never existed.
 */
const queues = new Map();
const serialized = (key, task) => {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(task);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
};

/** Where a version's content is, checked to be in its zone before anything is removed there. */
const contentPath = (zone, versionId) => {
  if (typeof versionId !== 'string' || !VERSION_ID_PATTERN.test(versionId)) {
    const error = new Error(`Refusing to act on a version id that is not one: ${versionId}`);
    error.code = 'VERSION_ID_INVALID';
    throw error;
  }
  return path.join(zones.versionsDirectory(zone.root), versionId);
};

/** The absolute path a live history names, or null when its zone is unknown. */
const absolutePathOf = (db, file) => {
  const zone = file ? trashStore.getZone(db, file.zoneId) : null;
  return zone ? path.join(zone.root, ...file.relativePath.split('/')) : null;
};

/** The zone a file's versions are kept in, and its path there, or null when it cannot have any. */
const placeOf = async (absolutePath) => {
  const located = await zones.locateZoneRoot(absolutePath);
  if (!located.root) return null;
  if (!(await zones.sameDevice(located.root, absolutePath))) return null;
  let zone;
  try {
    zone = await zones.ensureZone(located.root);
  } catch (error) {
    logger.warn(
      { err: error, root: located.root },
      'The zone for file versions could not be opened'
    );
    return null;
  }
  return { zone, relativePath: toRelative(zone.root, absolutePath) };
};

/** Whether content of this size could ever fit in the zone's budget. */
const tooLargeFor = async (root, size) => {
  // eslint-disable-next-line global-require
  const maintenance = require('../trash/maintenance');
  // eslint-disable-next-line global-require
  const { getTrashSettings } = require('../trash/settings');
  const { budgetBytes } = await maintenance.limitsFor(root, await getTrashSettings());
  return admission({ size, budgetBytes }) === 'too-large';
};

const requestPass = () => {
  try {
    // eslint-disable-next-line global-require
    require('../trash/maintenance').requestPass();
  } catch (error) {
    logger.debug({ err: error }, 'No maintenance pass could be requested after a capture');
  }
};

/** The new content takes the permissions of the one it replaces, and its owner where the process may. */
const matchOwnership = async (temporaryPath, stats) => {
  await fsp.chmod(temporaryPath, stats.mode & 0o7777).catch(() => {});
  await fsp.chown(temporaryPath, stats.uid, stats.gid).catch(() => {});
};

/**
 * Let go of one version: its content, then its row. A version whose zone is not
 * there is marked for removal and hidden, and the maintenance finishes it when
 * the disk comes back.
 */
const purgeVersion = async (versionId) => {
  if (inflight.has(versionId)) return { status: 'busy' };
  const db = await getDb();
  const version = store.getVersion(db, versionId);
  if (!version) return { status: 'missing' };

  const zone = trashStore.getZone(db, version.zoneId);
  if (!zone) {
    store.deleteVersion(db, versionId);
    return { status: 'purged', version };
  }
  const inspection = await zones.inspectZone(zone);
  if (!inspection.available) {
    store.setVersionState(db, versionId, 'purging');
    return { status: 'unavailable', reason: inspection.reason };
  }

  inflight.add(versionId);
  try {
    const payload = contentPath(zone, versionId);
    store.setVersionState(db, versionId, 'purging');
    await failpoints.hit('version-purge:after-intent', { id: versionId });
    await fsp.rm(payload, { force: true });
    await failpoints.hit('version-purge:after-remove', { id: versionId });
    store.deleteVersion(db, versionId);
    return { status: 'purged', version };
  } finally {
    inflight.delete(versionId);
  }
};

/** A whole history, every version with it. The row goes once no version is left anywhere. */
const purgeFile = async (fileId) => {
  const db = await getDb();
  const file = store.getFile(db, fileId);
  if (!file) return { status: 'missing' };
  if (file.state !== 'purging') store.setFileState(db, fileId, 'purging');

  let left = 0;
  const versions = store.listVersionsOfFile(db, fileId, {
    states: ['capturing', 'kept', 'purging'],
  });
  for (const version of versions) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await purgeVersion(version.id);
    if (outcome.status !== 'purged' && outcome.status !== 'missing') left += 1;
  }
  if (left === 0) store.deleteFile(db, fileId);
  return { status: left === 0 ? 'purged' : 'pending', left };
};

/** Apply the thinning rule to one file's history now, rather than at the next pass. */
const thinFile = async (fileId) => {
  const settings = await getVersionSettings();
  const db = await getDb();
  const versions = store
    .listVersionsOfFile(db, fileId)
    .filter((version) => !inflight.has(version.id))
    .map((version) => ({
      id: version.id,
      modifiedAt: Date.parse(version.modifiedAt),
      pinned: version.pinned,
    }));
  const drop = thinVersions({ versions, now: clock.now(), settings });
  for (const entry of drop) {
    // eslint-disable-next-line no-await-in-loop
    await purgeVersion(entry.id);
  }
  return drop;
};

/**
 * A save from an editing session that started before the file was restored:
 * its content becomes a version beside the others, and the file keeps the
 * content the restore put back.
 */
const setAside = async ({ db, zone, file, temporaryPath, incoming, author, source }) => {
  const id = generateId();
  const directory = zones.versionsDirectory(zone.root);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  inflight.add(id);
  try {
    store.insertVersion(db, {
      id,
      fileId: file.id,
      zoneId: zone.id,
      state: 'capturing',
      size: incoming.size,
      sha256: incoming.sha256,
      modifiedAt: clock.nowIso(),
      authorId: author.id,
      authorLabel: author.label,
      source,
      aside: true,
    });
    try {
      await fsp.rename(temporaryPath, path.join(directory, id));
    } catch (error) {
      store.deleteVersion(db, id);
      throw error;
    }
    store.setVersionState(db, id, 'kept');
  } finally {
    inflight.delete(id);
  }
  requestPass();
  return store.getVersion(db, id);
};

const replaceNow = async (target, temporaryPath, meta) => {
  const author = meta.author || {};
  const session = meta.session?.key ? meta.session : null;
  const current = await lstatOrNull(target);
  if (!current?.isFile()) {
    await fsp.rename(temporaryPath, target);
    return { status: current ? 'replaced' : 'created', version: null };
  }
  await matchOwnership(temporaryPath, current);

  const settings = await getVersionSettings();
  const place = settings.enabled ? await placeOf(target) : null;
  if (!place) {
    await fsp.rename(temporaryPath, target);
    return { status: 'replaced', version: null };
  }

  const db = await getDb();
  const { zone, relativePath } = place;
  let file = store.findFileAt(db, zone.id, relativePath, ['live', 'orphaned']);
  if (file?.state === 'orphaned') {
    // The file came back where its history was: the history is its own again.
    store.setFileState(db, file.id, 'live');
    file = store.getFile(db, file.id);
  }

  const incoming = await hashFile(temporaryPath);
  const fingerprintMatches =
    Boolean(file?.currentSha256) &&
    file.currentSize === current.size &&
    file.currentMtimeMs === current.mtimeMs;
  const outgoingSha256 = fingerprintMatches ? file.currentSha256 : (await hashFile(target)).sha256;

  if (incoming.sha256 === outgoingSha256) {
    await fsp.rm(temporaryPath, { force: true });
    return { status: 'unchanged', version: null };
  }

  // Asked of the session as given: a save can know when its session started
  // without belonging to one the coalescing can follow.
  if (file && isStaleSave({ history: file, session: meta.session })) {
    const version = await setAside({
      db,
      zone,
      file,
      temporaryPath,
      incoming,
      author,
      source: meta.source || null,
    });
    return { status: 'set-aside', version };
  }

  const now = clock.now();
  const newSession = !session || file?.currentSession !== session.key;
  let keep =
    sessionDecision({
      history: file,
      fingerprintMatches,
      session,
      now,
      checkpointMinutes: settings.sessionCheckpointMinutes,
    }) === 'keep';
  if (keep && file) {
    const [latest] = store.listVersionsOfFile(db, file.id);
    // Already in the history: the same content twice is one version.
    if (latest?.sha256 === outgoingSha256) keep = false;
  }
  if (keep && (await tooLargeFor(zone.root, current.size))) {
    keep = false;
    trashStore.insertEvent(db, {
      zoneId: zone.id,
      itemName: path.basename(target),
      kind: 'version-too-large',
      detail: JSON.stringify({ path: relativePath, size: current.size }),
    });
  }

  const recordNewContent = (fileId, after, checkpointAt) =>
    store.recordCurrent(db, fileId, {
      sha256: incoming.sha256,
      size: after.size,
      mtimeMs: after.mtimeMs,
      authorId: author.id,
      authorLabel: author.label,
      source: meta.source,
      session: session?.key || null,
      explicit: meta.explicit === true || !session,
      checkpointAt,
    });

  if (!keep) {
    await fsp.rename(temporaryPath, target);
    if (file) {
      const after = await fsp.lstat(target);
      recordNewContent(file.id, after, newSession ? clock.nowIso() : file.sessionCheckpointAt);
    }
    return { status: 'replaced', version: null };
  }

  if (!file) {
    file = store.insertFile(db, { id: generateId(), zoneId: zone.id, relativePath });
  }
  const versionId = generateId();
  const directory = zones.versionsDirectory(zone.root);
  const payload = path.join(directory, versionId);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });

  inflight.add(versionId);
  try {
    store.insertVersion(db, {
      id: versionId,
      fileId: file.id,
      zoneId: zone.id,
      state: 'capturing',
      size: current.size,
      sha256: outgoingSha256,
      modifiedAt: new Date(current.mtimeMs).toISOString(),
      authorId: fingerprintMatches ? file.currentAuthorId : null,
      authorLabel: fingerprintMatches ? file.currentAuthorLabel : null,
      source: fingerprintMatches ? file.currentSource : 'external',
    });
    await failpoints.hit('version:after-row', { id: versionId });

    let linked = true;
    try {
      await fsp.link(target, payload);
    } catch (error) {
      if (!LINK_REFUSED.has(error?.code)) {
        store.deleteVersion(db, versionId);
        throw error;
      }
      linked = false;
    }
    await failpoints.hit('version:after-link', { id: versionId, linked });

    if (!linked) {
      try {
        await fsp.rename(target, payload);
      } catch (error) {
        store.deleteVersion(db, versionId);
        throw error;
      }
      // Outside the undo below, as every failpoint is: a process that died
      // here would not have put anything back.
      await failpoints.hit('version:between-renames', { id: versionId });
    }

    try {
      await fsp.rename(temporaryPath, target);
    } catch (error) {
      // Put things back as they were: the old content at its path, no version.
      if (linked) await fsp.rm(payload, { force: true }).catch(() => {});
      else await fsp.rename(payload, target).catch(() => {});
      store.deleteVersion(db, versionId);
      throw error;
    }
    await failpoints.hit('version:after-rename', { id: versionId });

    const after = await fsp.lstat(target);
    db.transaction(() => {
      store.setVersionState(db, versionId, 'kept');
      recordNewContent(file.id, after, clock.nowIso());
    })();
  } finally {
    inflight.delete(versionId);
  }

  try {
    await thinFile(file.id);
  } catch (error) {
    logger.warn(
      { err: error, fileId: file.id },
      'A file history could not be thinned after a save'
    );
  }
  requestPass();
  return { status: 'replaced', version: store.getVersion(db, versionId) };
};

/**
 * Replace a file with content already written beside it, keeping what it
 * replaces as a version when that is worth it.
 *
 * @param {string} absolutePath   the file being saved
 * @param {string} temporaryPath  the new content, in the same directory
 * @param {object} [meta]
 * @param {{ id?: string|null, label?: string|null }} [meta.author]  who is saving
 * @param {string} [meta.source]      editor | share-editor | onlyoffice | collabora | restore
 * @param {{ key: string, startedAt?: number }|null} [meta.session]  the editing session, if any
 * @param {boolean} [meta.explicit]   saved on purpose rather than automatically
 * @returns {Promise<{ status: 'created'|'replaced'|'unchanged'|'set-aside', version: object|null }>}
 */
const replaceWithTemporary = (absolutePath, temporaryPath, meta = {}) => {
  const target = path.resolve(absolutePath);
  return serialized(target, () => replaceNow(target, temporaryPath, meta));
};

/** A name beside a file for new content on its way in, hidden and unique. */
const temporaryPathFor = (absolutePath, purpose = 'save') =>
  path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.nextexplorer-${purpose}-${crypto.randomUUID()}.tmp`
  );

/**
 * Save a file the way every editor of the application does: the new content is
 * written beside it by `writeContent`, then replaces it in one rename, keeping
 * what it replaces as a version when that is worth it. Whatever happens, no
 * temporary file is left behind.
 *
 * Writing in place, as the text editor used to, left a truncated file behind a
 * crash in the middle of a save; a rename cannot.
 *
 * @param {string} absolutePath
 * @param {(temporaryPath: string) => Promise<void>} writeContent
 * @param {object} [meta]  as for replaceWithTemporary, plus `purpose` for the temporary name
 */
const saveFile = async (absolutePath, writeContent, meta = {}) => {
  const temporaryPath = temporaryPathFor(absolutePath, meta.purpose || 'save');
  const inFlight = trackInFlight(temporaryPath, 'temporary-file');
  try {
    await writeContent(temporaryPath);
    return await replaceWithTemporary(absolutePath, temporaryPath, meta);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    inFlight.release();
  }
};

/**
 * Save content as a new file in `directory`, under `desiredName` or the first
 * free name after it, "notes (1).md". Answers the name and path it took.
 *
 * The content is written beside the name by `writeContent`, then put under it
 * by a move that never replaces anything. Going through `saveFile` with a name
 * chosen beforehand meant a file that arrived under that name while the content
 * was being written was replaced, its content kept as an earlier version of a
 * file it had nothing to do with. A file that did not exist has no history, so
 * nothing is recorded, as `saveFile` records nothing when it creates a file.
 * Whatever happens, no temporary file is left behind.
 *
 * @param {string} directory
 * @param {string} desiredName
 * @param {(temporaryPath: string) => Promise<void>} writeContent
 * @param {{ purpose?: string }} [meta]  `purpose` for the temporary name
 * @returns {Promise<{ name: string, path: string }>}
 */
const saveNewFile = async (directory, desiredName, writeContent, meta = {}) => {
  const temporaryPath = temporaryPathFor(path.join(directory, desiredName), meta.purpose || 'save');
  const inFlight = trackInFlight(temporaryPath, 'temporary-file');
  try {
    await writeContent(temporaryPath);
    return await placeWithoutOverwrite(temporaryPath, directory, desiredName);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    inFlight.release();
  }
};

/** Who is saving, as a version records it: an account, or a share link's visitor. */
const authorOf = ({ user = null, guestSession = null } = {}) => ({
  id: user?.id ? String(user.id) : null,
  label: user
    ? user.displayName || user.username || user.email || null
    : guestSession
      ? 'share-link'
      : null,
});

/** A version and where its content is, when its zone is there to read it from. */
const locateVersion = async (versionId) => {
  const db = await getDb();
  const version = store.getVersion(db, versionId);
  if (!version || version.state !== 'kept') return { status: 'missing' };
  const zone = trashStore.getZone(db, version.zoneId);
  const inspection = zone ? await zones.inspectZone(zone) : { available: false, reason: 'missing' };
  if (!inspection.available) return { status: 'unavailable', reason: inspection.reason, version };
  const absolutePath = contentPath(zone, version.id);
  const stats = await lstatOrNull(absolutePath);
  if (!stats?.isFile()) return { status: 'missing' };
  return { status: 'found', version, absolutePath, zone };
};

/**
 * Bring a zone's versions and its disk back into agreement.
 *
 * - A capture interrupted before the new content arrived leaves a link that
 *   still shares the file's inode: it is dropped, and the file keeps its content.
 *   Past that point the version is whole and kept.
 * - A purge interrupted is finished.
 * - A history on its way out loses what it keeps in this zone, and goes once
 *   nothing of it is left anywhere.
 * - A kept version whose content has gone is dropped, unless so many have gone
 *   at once that the zone itself looks wrong.
 * - Content with no row, older than the grace period, is removed: it is a copy
 *   the application made, with no file left to belong to.
 */
const recoverZone = async (
  zone,
  { graceMs = ORPHAN_CONTENT_GRACE_MS, breakerRatio = 0.2, breakerMinimum = 5 } = {}
) => {
  const report = { finished: 0, undone: 0, purged: 0, lost: 0, removedContents: 0, breaker: false };
  const inspection = await zones.inspectZone(zone);
  if (!inspection.available) return { ...report, skipped: true, reason: inspection.reason };

  const db = await getDb();
  const directory = zones.versionsDirectory(zone.root);
  const names = await readdirOrEmpty(directory);
  const onDisk = new Set(names);
  const rows = store.listVersionsInZone(db, zone.id);
  const known = new Set(rows.map((row) => row.id));

  for (const row of rows) {
    if (inflight.has(row.id) || !VERSION_ID_PATTERN.test(row.id)) continue;
    const payload = path.join(directory, row.id);
    if (row.state === 'capturing') {
      if (!onDisk.has(row.id)) {
        store.deleteVersion(db, row.id);
        report.undone += 1;
        continue;
      }
      const file = store.getFile(db, row.fileId);
      const livePath = file?.state === 'live' ? absolutePathOf(db, file) : null;
      // eslint-disable-next-line no-await-in-loop
      const [content, live] = await Promise.all([
        lstatOrNull(payload),
        livePath ? lstatOrNull(livePath) : null,
      ]);
      if (!row.aside && content && live && content.ino === live.ino && content.dev === live.dev) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(payload, { force: true });
        store.deleteVersion(db, row.id);
        report.undone += 1;
      } else if (!row.aside && content && livePath && !live) {
        // Renamed out of the way on a filesystem without hard links, and the
        // new content never took its place: the file gets its content back.
        // eslint-disable-next-line no-await-in-loop
        await fsp.rename(payload, livePath);
        store.deleteVersion(db, row.id);
        report.undone += 1;
      } else {
        store.setVersionState(db, row.id, 'kept');
        report.finished += 1;
      }
    } else if (row.state === 'purging') {
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(payload, { force: true });
      store.deleteVersion(db, row.id);
      report.purged += 1;
    }
  }

  const kept = store
    .listVersionsInZone(db, zone.id)
    .filter((row) => row.state === 'kept' && !inflight.has(row.id));
  const vanished = [];
  for (const row of kept) {
    if (onDisk.has(row.id)) continue;
    // Looked at again: a capture that finished since the directory was read
    // is not a loss.
    // eslint-disable-next-line no-await-in-loop
    if (!(await lstatOrNull(path.join(directory, row.id)))) vanished.push(row);
  }
  if (
    vanished.length >= breakerMinimum &&
    vanished.length / Math.max(1, kept.length) > breakerRatio
  ) {
    report.breaker = true;
    trashStore.insertEvent(db, {
      zoneId: zone.id,
      kind: 'versions-breaker',
      detail: JSON.stringify({ vanished: vanished.length, kept: kept.length }),
    });
  } else {
    for (const row of vanished) {
      store.deleteVersion(db, row.id);
      trashStore.insertEvent(db, {
        zoneId: zone.id,
        itemId: row.id,
        kind: 'version-lost',
        detail: JSON.stringify({ fileId: row.fileId }),
      });
      report.lost += 1;
    }
  }

  for (const file of store.listFiles(db, { state: 'purging' })) {
    const versions = store.listVersionsOfFile(db, file.id, {
      states: ['capturing', 'kept', 'purging'],
    });
    for (const version of versions) {
      if (version.zoneId !== zone.id || inflight.has(version.id)) continue;
      if (!VERSION_ID_PATTERN.test(version.id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(contentPath(zone, version.id), { force: true });
      store.deleteVersion(db, version.id);
      report.purged += 1;
    }
    if (
      store.listVersionsOfFile(db, file.id, { states: ['capturing', 'kept', 'purging'] }).length ===
      0
    ) {
      store.deleteFile(db, file.id);
    }
  }

  const stillKnown = new Set(store.listVersionsInZone(db, zone.id).map((row) => row.id));
  for (const name of names) {
    if (known.has(name) || stillKnown.has(name) || inflight.has(name)) continue;
    if (!VERSION_ID_PATTERN.test(name)) continue;
    const absolute = path.join(directory, name);
    // eslint-disable-next-line no-await-in-loop
    const stats = await lstatOrNull(absolute);
    if (!stats || (graceMs > 0 && clock.now() - stats.ctimeMs < graceMs)) continue;
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(absolute, { recursive: true, force: true });
    report.removedContents += 1;
  }

  return report;
};

module.exports = {
  VERSION_ID_PATTERN,
  ORPHAN_CONTENT_GRACE_MS,
  inflight,
  hashFile,
  absolutePathOf,
  placeOf,
  temporaryPathFor,
  replaceWithTemporary,
  saveFile,
  saveNewFile,
  authorOf,
  locateVersion,
  purgeVersion,
  purgeFile,
  thinFile,
  recoverZone,
};
