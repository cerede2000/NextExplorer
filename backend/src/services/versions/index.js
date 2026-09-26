/**
 * File versions as the rest of the application sees them.
 *
 * The modules beside this one keep what saves replace and follow files around;
 * this one decides who is asking and what they may do with a file's history:
 *
 *   - seeing it follows the right to read the file — except through a share,
 *     whose owner decides whether its history is shown at all;
 *   - downloading a version, or copying it out, is taking a copy, so it also
 *     needs the right to download — and through a share, the owner's say-so;
 *   - restoring, naming or pinning changes the file, and needs the right to
 *     write it;
 *   - deleting versions needs the right to delete the file.
 *
 * Restoring never destroys anything: the content it replaces becomes a version,
 * like any other save, and the restored version stays in the history.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { ZONE_DIRECTORY_NAME } = require('../../config/constants');
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { ensureValidName, normalizeRelativePath } = require('../../utils/pathUtils');
const { ACTIONS, authorizeAndResolve, authorizePath } = require('../authorizationService');
const { getDb } = require('../db');
const { readTextFile } = require('../textEditorService');
const clock = require('../trash/clock');
const trashStore = require('../trash/store');
const zones = require('../trash/zones');
const operations = require('./operations');
const { getVersionSettings } = require('./settings');
const store = require('./store');

const MAX_IDS = 1000;
const MAX_LABEL_LENGTH = 200;

/**
 * What this person may do with a file's history, from what they may do with the
 * file. A share hands out its history only when its owner turned it on.
 */
const rightsFrom = (accessInfo) => {
  const shared = Boolean(accessInfo?.isShared);
  const share = accessInfo?.share || null;
  const see = Boolean(accessInfo?.canRead) && (!shared || share?.versionsVisible === true);
  const download =
    see && accessInfo?.canDownload !== false && (!shared || share?.versionsDownload === true);
  const restore = see && Boolean(accessInfo?.canWrite);
  return { see, download, restore, remove: see && Boolean(accessInfo?.canDelete) };
};

const relativeFrom = (value, what = 'A file path') => {
  const relative = typeof value === 'string' ? normalizeRelativePath(value) : '';
  if (!relative) throw new ValidationError(`${what} is required.`);
  return relative;
};

/** Resolve and authorize a path, answering a path that is not one as not found. */
const authorize = async (context, relative, action) => {
  try {
    return await authorizeAndResolve(context, relative, action);
  } catch (error) {
    if (error?.isOperational) throw error;
    throw new NotFoundError('This file does not exist.');
  }
};

/** The file a request is about, with what this person may do with its history. */
const resolveFile = async (context, relativePath) => {
  const relative = relativeFrom(relativePath);
  const { allowed, accessInfo, resolved } = await authorize(context, relative, ACTIONS.read);
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
  }
  const stats = await fsp.stat(resolved.absolutePath).catch(() => null);
  if (!stats) throw new NotFoundError('This file does not exist.');
  if (!stats.isFile()) throw new ValidationError('Only files have versions.');
  return {
    relative,
    absolutePath: resolved.absolutePath,
    stats,
    rights: rightsFrom(accessInfo),
  };
};

/** The history of the file at an absolute path, whichever zone row its root has. */
const historyOf = async (db, absolutePath) => {
  const located = await zones.locateZoneRoot(absolutePath);
  if (!located.root) return null;
  const relativePath = path.relative(located.root, absolutePath).split(path.sep).join('/');
  for (const zone of trashStore.listZones(db).filter((row) => row.root === located.root)) {
    const file = store.findFileAt(db, zone.id, relativePath, ['live', 'orphaned']);
    if (file) return file;
  }
  return null;
};

/**
 * How many kept versions each file in a folder has, by file name.
 *
 * What the listing needs to put a mark on a row, and the reason it is a
 * folder's worth at a time: a count per file would be one query per row, and
 * a folder of three hundred files is an ordinary folder.
 *
 * The zone root is resolved once here. `locateZoneRoot` answers `zone-root`
 * for the root itself rather than naming it — true for a file being deleted,
 * which cannot go into its own volume's trash, and wrong for a listing, where
 * the top of a volume is a folder like any other and its files have
 * histories. So that answer is turned back into the zone it is about.
 */
const marksForFolder = async (absoluteDir) => {
  const directory = path.resolve(absoluteDir);
  const located = await zones.locateZoneRoot(directory);
  if (!located.root && located.reason !== 'zone-root') return new Map();

  const db = await getDb();
  const root = located.root || directory;
  const relative = located.root ? path.relative(root, directory).split(path.sep).join('/') : '';
  // Outside the zone after all: nothing here belongs to it.
  if (relative.startsWith('..')) return new Map();

  const zoneIds = trashStore
    .listZones(db)
    .filter((row) => row.root === root)
    .map((row) => row.id);
  if (zoneIds.length === 0) return new Map();

  const marks = new Map();
  for (const row of store.countKeptInFolder(db, zoneIds, relative)) {
    const name = path.posix.basename(row.relativePath);
    const existing = marks.get(name);
    marks.set(
      name,
      existing
        ? {
            versions: existing.versions + row.versions,
            bytes: existing.bytes + row.bytes,
            newest: existing.newest > row.newest ? existing.newest : row.newest,
          }
        : { versions: row.versions, bytes: row.bytes, newest: row.newest }
    );
  }
  return marks;
};

/** The names accounts go by now, for the versions they wrote. */
const accountLabels = (db, ids) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  try {
    return new Map(
      db
        .prepare(
          `SELECT id, display_name, username, email FROM users
            WHERE id IN (${wanted.map(() => '?').join(', ')})`
        )
        .all(...wanted)
        .map((row) => [row.id, row.display_name || row.username || row.email || null])
    );
  } catch (error) {
    logger.debug({ err: error }, 'Account names were not found for file versions');
    return new Map();
  }
};

const authorOf = (labels, id, storedLabel) =>
  id || storedLabel
    ? { id: id || null, label: (id && labels.get(id)) || storedLabel || null }
    : null;

const presentVersion = (version, labels, available) => ({
  id: version.id,
  size: version.size,
  modifiedAt: version.modifiedAt,
  capturedAt: version.capturedAt,
  author: authorOf(labels, version.authorId, version.authorLabel),
  source: version.source,
  label: version.label,
  pinned: version.pinned,
  aside: version.aside,
  available,
});

/** A file's history: its versions, newest first, and what this person may do with them. */
const listVersions = async (context, relativePath) => {
  const target = await resolveFile(context, relativePath);
  if (!target.rights.see) throw new ForbiddenError('The history of this file is not shared.');

  const settings = await getVersionSettings();
  const db = await getDb();
  const file = await historyOf(db, target.absolutePath);
  const versions = file ? store.listVersionsOfFile(db, file.id) : [];

  const availability = new Map();
  for (const zoneId of new Set(versions.map((version) => version.zoneId))) {
    const zone = trashStore.getZone(db, zoneId);
    availability.set(zoneId, zone ? (await zones.inspectZone(zone)).available : false);
  }
  const labels = accountLabels(db, [
    ...versions.map((version) => version.authorId),
    file?.currentAuthorId,
  ]);
  const currentKnown =
    Boolean(file) &&
    file.currentSize === target.stats.size &&
    file.currentMtimeMs === target.stats.mtimeMs;

  return {
    enabled: settings.enabled,
    file: {
      name: path.basename(target.absolutePath),
      path: target.relative,
      size: target.stats.size,
      modifiedAt: target.stats.mtime.toISOString(),
      author: currentKnown ? authorOf(labels, file.currentAuthorId, file.currentAuthorLabel) : null,
      source: currentKnown ? file.currentSource : null,
    },
    versions: versions.map((version) =>
      presentVersion(version, labels, availability.get(version.zoneId))
    ),
    totalBytes: versions.reduce((total, version) => total + version.size, 0),
    rights: target.rights,
  };
};

/** The default name of a version taken out of its history: the file's, with the version's date. */
const nameForCopy = (fileName, version) => {
  const extension = path.extname(fileName);
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  const stamp = new Date(version.modifiedAt).toISOString().slice(0, 16).replace('T', ' ');
  return `${base} (version ${stamp.replace(':', '-')})${extension}`;
};

/** One version of the file a request is about, and where its content can be read. */
const locateVersion = async (context, relativePath, versionId, { download }) => {
  const target = await resolveFile(context, relativePath);
  if (!target.rights.see) throw new ForbiddenError('The history of this file is not shared.');
  if (download && !target.rights.download) {
    throw new ForbiddenError('Earlier versions of this file cannot be downloaded.');
  }
  const db = await getDb();
  const file = await historyOf(db, target.absolutePath);
  const version =
    file && typeof versionId === 'string' && versionId ? store.getVersion(db, versionId) : null;
  if (!version || version.fileId !== file.id || version.state !== 'kept') {
    throw new NotFoundError('This version does not exist.');
  }
  const located = await operations.locateVersion(version.id);
  if (located.status === 'unavailable') {
    throw new ConflictError('The volume this version is kept on is not available.');
  }
  if (located.status !== 'found') throw new NotFoundError('This version does not exist.');
  const stats = await fsp.stat(located.absolutePath);
  return {
    target,
    file,
    version,
    absolutePath: located.absolutePath,
    size: stats.size,
    name: path.basename(target.absolutePath),
  };
};

/** A version to download: its content, and the name it is offered under. */
const downloadVersion = async (context, relativePath, versionId) => {
  const located = await locateVersion(context, relativePath, versionId, { download: true });
  return { ...located, downloadName: nameForCopy(located.name, located.version) };
};

/** The text of a version, to read before deciding what to do with it. Nothing is written. */
const readVersionText = async (context, relativePath, versionId) => {
  const located = await locateVersion(context, relativePath, versionId, { download: false });
  const { text } = await readTextFile(located.absolutePath);
  return {
    name: located.name,
    size: located.size,
    modifiedAt: located.version.modifiedAt,
    content: text,
  };
};

/**
 * After a restore, an editor still open on the file holds the content it
 * replaced. Its next save is set aside as a version of its own rather than
 * written over what was just restored, and the document is given a fresh
 * identity so whoever opens it next gets what was restored rather than the
 * Document Server's cached copy of what it replaced.
 */
const markRestored = async (absolutePath, relative) => {
  try {
    const db = await getDb();
    const file = await historyOf(db, absolutePath);
    if (file) store.setRestoredAt(db, file.id, clock.nowIso());
    // Required here rather than at the top: the key service is part of the
    // office integration, which reaches back into the versions.
    // eslint-disable-next-line global-require
    await require('../onlyofficeDocumentKeyService').releaseDocumentKey(relative);
  } catch (error) {
    logger.warn({ err: error, absolutePath }, 'A restore could not be announced to open editors');
  }
};

/** Put a version's content into a file, the way every save does. */
const writeVersionInto = async (located, destination, context) => {
  const result = await operations.saveFile(
    destination,
    (temporaryPath) =>
      fsp.copyFile(located.absolutePath, temporaryPath, fs.constants.COPYFILE_FICLONE),
    {
      purpose: 'restore',
      author: operations.authorOf(context),
      source: 'restore',
      explicit: true,
    }
  );
  return result;
};

/** Put the file back as a version had it. What it holds now becomes a version itself. */
const restoreVersion = async (context, relativePath, versionId) => {
  const located = await locateVersion(context, relativePath, versionId, { download: false });
  if (!located.target.rights.restore) throw new ForbiddenError('This file cannot be changed.');
  const result = await writeVersionInto(located, located.target.absolutePath, context);
  if (result.status !== 'unchanged') {
    await markRestored(located.target.absolutePath, located.target.relative);
  }
  return { status: result.status, path: located.target.relative };
};

/** A folder someone chose to put something in: one they can reach, and a folder. */
const resolveFolder = async (context, value) => {
  const relative = relativeFrom(value, 'A destination folder');
  const { allowed, accessInfo, resolved } = await authorize(context, relative, ACTIONS.read);
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'This destination cannot be reached.');
  }
  const stats = await fsp.stat(resolved.absolutePath).catch(() => null);
  if (!stats?.isDirectory())
    throw new ValidationError('The destination must be an existing folder.');
  if (resolved.absolutePath.split(path.sep).includes(ZONE_DIRECTORY_NAME)) {
    throw new ValidationError('The destination must be an existing folder.');
  }
  return { relative, absolutePath: resolved.absolutePath };
};

/** Take a version out of the history as a new file, in a folder someone chose. */
const copyVersionTo = async (context, relativePath, versionId, { destination, name } = {}) => {
  const located = await locateVersion(context, relativePath, versionId, { download: true });
  const folder = await resolveFolder(context, destination);
  const { allowed } = await authorizePath(context, folder.relative, ACTIONS.createFile);
  if (!allowed) throw new ForbiddenError('Files cannot be created in this folder.');

  let wanted = nameForCopy(located.name, located.version);
  if (name !== undefined && name !== null && name !== '') {
    try {
      wanted = ensureValidName(String(name));
    } catch (error) {
      throw new ValidationError(error.message);
    }
  }
  // A new file, never one already there: the copy lands under a name nothing
  // holds, "(1)" when taken, even by a file that arrives while it is written.
  // Putting it through the save of an existing file would have replaced such a
  // file, and kept it as an earlier version of the copy.
  const placed = await operations.saveNewFile(
    folder.absolutePath,
    wanted,
    (temporaryPath) =>
      fsp.copyFile(located.absolutePath, temporaryPath, fs.constants.COPYFILE_FICLONE),
    { purpose: 'restore' }
  );
  const finalName = placed.name;
  return { path: `${folder.relative}/${finalName}`, name: finalName };
};

/** Put a version's content into another existing file, whose own content becomes a version. */
const replaceWithVersion = async (context, relativePath, versionId, { target } = {}) => {
  const located = await locateVersion(context, relativePath, versionId, { download: true });
  const other = relativeFrom(target, 'The file to replace');
  const { allowed, accessInfo, resolved } = await authorize(context, other, ACTIONS.write);
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'This file cannot be changed.');
  }
  const stats = await fsp.stat(resolved.absolutePath).catch(() => null);
  if (!stats?.isFile()) throw new ValidationError('The file to replace must be an existing file.');

  const result = await writeVersionInto(located, resolved.absolutePath, context);
  if (result.status !== 'unchanged') await markRestored(resolved.absolutePath, other);
  return { status: result.status, path: other };
};

/** Name a version, or pin it so that nothing but the space the zone has ever removes it. */
const updateVersion = async (context, relativePath, versionId, { label, pinned } = {}) => {
  const located = await locateVersion(context, relativePath, versionId, { download: false });
  if (!located.target.rights.restore) throw new ForbiddenError('This file cannot be changed.');
  if (label !== undefined && label !== null && typeof label !== 'string') {
    throw new ValidationError('A version name is text.');
  }
  if (typeof label === 'string' && label.trim().length > MAX_LABEL_LENGTH) {
    throw new ValidationError(`A version name is at most ${MAX_LABEL_LENGTH} characters.`);
  }
  if (pinned !== undefined && typeof pinned !== 'boolean') {
    throw new ValidationError('Pinned is true or false.');
  }
  const db = await getDb();
  store.setVersionDetails(db, located.version.id, {
    label: label === undefined ? undefined : String(label || '').trim() || null,
    pinned,
  });
  const updated = store.getVersion(db, located.version.id);
  return presentVersion(updated, accountLabels(db, [updated.authorId]), true);
};

/** Delete versions of a file for good: some of them, or all. The file itself is untouched. */
const deleteVersions = async (context, relativePath, { ids, all = false } = {}) => {
  const target = await resolveFile(context, relativePath);
  if (!target.rights.see) throw new ForbiddenError('The history of this file is not shared.');
  if (!target.rights.remove) throw new ForbiddenError('Versions of this file cannot be deleted.');

  const db = await getDb();
  const file = await historyOf(db, target.absolutePath);
  const kept = file ? store.listVersionsOfFile(db, file.id) : [];
  let wanted;
  if (all === true) {
    wanted = kept.map((version) => version.id);
  } else {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('At least one version is required.');
    }
    if (ids.length > MAX_IDS) {
      throw new ValidationError(`At most ${MAX_IDS} versions can be deleted at once.`);
    }
    if (!ids.every((id) => typeof id === 'string' && id)) {
      throw new ValidationError('Version ids must be strings.');
    }
    wanted = [...new Set(ids)];
  }

  const belongs = new Set(kept.map((version) => version.id));
  const items = [];
  for (const id of wanted) {
    if (!belongs.has(id)) {
      items.push({ id, status: 'not-found' });
      continue;
    }
    try {
      const outcome = await operations.purgeVersion(id);
      items.push({ id, status: outcome.status === 'unavailable' ? 'pending' : outcome.status });
    } catch (error) {
      logger.warn({ err: error, versionId: id }, 'A version could not be deleted');
      items.push({ id, status: 'failed' });
    }
  }
  return {
    items,
    deleted: items.filter((item) => item.status === 'purged' || item.status === 'pending').length,
  };
};

/**
 * ---------------------------------------------------------------------------
 * The whole installation's histories, for an administrator.
 *
 * Everything above answers about one file, and answers it with that file's
 * own rights — which is the right shape for the person using the browser, and
 * the wrong one for the question "what is taking the space, and where". That
 * question has no path to hang on: a history whose file was deleted outside
 * the application has no file left to be authorised against, and it is
 * exactly the kind that nobody goes looking for.
 *
 * So these are addressed by the history's own id, and they are behind
 * `ensureAdmin`. Two consequences worth stating rather than discovering:
 * this lists paths from every space, personal folders included, which the
 * browsing API never lets one account see of another; and it can delete a
 * history that its owner would still want. It is an administrator's screen in
 * the same sense as the trash's zones are.
 * ---------------------------------------------------------------------------
 */

/** Each zone by id, with the shape the screen shows it in. */
const describeZones = (db) =>
  new Map(
    trashStore.listZones(db).map((zone) => {
      const described = zones.describeZoneRoot(zone.root);
      return [
        zone.id,
        { id: zone.id, root: zone.root, kind: described.kind, name: described.name },
      ];
    })
  );

/**
 * The path a browser could open, when there is one.
 *
 * Only a volume has one: its logical path is its name and then the path
 * inside it. A personal folder is addressed as `personal/…` by the one
 * account it belongs to and by nobody else, so an administrator looking at
 * somebody else's has no address to be given — and being handed a link that
 * answers 404 is worse than being handed none.
 */
const logicalPathFor = (zone, relativePath) =>
  zone?.kind === 'volume' ? `${zone.name}/${relativePath}` : null;

const ADMIN_PAGE_SIZE = 25;
const MAX_ADMIN_PAGE_SIZE = 200;

const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
};

/** A page of the files that have a history, and what the whole filter holds. */
const listFilesWithVersions = async ({
  zoneId = null,
  state = null,
  query = '',
  sort = 'bytes',
  limit = ADMIN_PAGE_SIZE,
  offset = 0,
} = {}) => {
  if (state !== null && state !== undefined && state !== '' && !store.FILE_STATES.includes(state)) {
    throw new ValidationError('That is not a state a history can be in.');
  }
  if (sort && !Object.keys(store.ADMIN_SORTS).includes(sort)) {
    throw new ValidationError('That is not an order this list can be read in.');
  }
  if (typeof query !== 'string') throw new ValidationError('A search is text.');

  const db = await getDb();
  const zoneMap = describeZones(db);
  const filter = {
    zoneId: zoneId || null,
    state: state || null,
    query: query.slice(0, 200),
  };
  const page = {
    ...filter,
    sort: sort || 'bytes',
    limit: boundedInteger(limit, ADMIN_PAGE_SIZE, 1, MAX_ADMIN_PAGE_SIZE),
    offset: boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };

  const rows = store.listFilesWithVersions(db, page);
  const totals = store.summariseFilesWithVersions(db, filter);

  return {
    files: rows.map((row) => {
      const zone = zoneMap.get(row.zoneId) || null;
      return {
        id: row.id,
        name: path.posix.basename(row.relativePath),
        relativePath: row.relativePath,
        folder:
          path.posix.dirname(row.relativePath) === '.' ? '' : path.posix.dirname(row.relativePath),
        path: logicalPathFor(zone, row.relativePath),
        state: row.state,
        versions: row.versions,
        bytes: row.bytes,
        newest: row.newest,
        zone: zone ? { id: zone.id, kind: zone.kind, name: zone.name } : null,
      };
    }),
    total: totals.files,
    totalBytes: totals.bytes,
    totalVersions: totals.versions,
    limit: page.limit,
    offset: page.offset,
    zones: [...zoneMap.values()].map((zone) => ({
      id: zone.id,
      kind: zone.kind,
      name: zone.name,
    })),
    states: [...store.FILE_STATES],
    sorts: Object.keys(store.ADMIN_SORTS),
  };
};

/** One history, with its versions — the same shape the panel shows, by id. */
const readFileVersions = async (fileId) => {
  const db = await getDb();
  const file = typeof fileId === 'string' && fileId ? store.getFile(db, fileId) : null;
  if (!file) throw new NotFoundError('This history does not exist.');

  const zone = describeZones(db).get(file.zoneId) || null;
  const versions = store.listVersionsOfFile(db, file.id);
  const availability = new Map();
  for (const zoneId of new Set(versions.map((version) => version.zoneId))) {
    const row = trashStore.getZone(db, zoneId);
    availability.set(zoneId, row ? (await zones.inspectZone(row)).available : false);
  }
  const labels = accountLabels(
    db,
    versions.map((version) => version.authorId)
  );

  return {
    file: {
      id: file.id,
      name: path.posix.basename(file.relativePath),
      relativePath: file.relativePath,
      path: logicalPathFor(zone, file.relativePath),
      state: file.state,
      zone: zone ? { id: zone.id, kind: zone.kind, name: zone.name } : null,
    },
    versions: versions.map((version) =>
      presentVersion(version, labels, availability.get(version.zoneId))
    ),
    totalBytes: versions.reduce((total, version) => total + version.size, 0),
  };
};

/**
 * Delete versions of one history, named by the history rather than by a path.
 *
 * `all` on a history whose file is gone takes the row with it: keeping an
 * entry that leads to nothing would leave the list showing a file that has
 * neither content nor versions. A live file keeps its row, because that row
 * is also what the next save reads to tell an editing session from a change
 * made behind its back.
 */
const deleteFileVersions = async (fileId, { ids, all = false } = {}) => {
  const db = await getDb();
  const file = typeof fileId === 'string' && fileId ? store.getFile(db, fileId) : null;
  if (!file) throw new NotFoundError('This history does not exist.');

  const kept = store.listVersionsOfFile(db, file.id);
  let wanted;
  if (all === true) {
    wanted = kept.map((version) => version.id);
  } else {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('At least one version is required.');
    }
    if (ids.length > MAX_IDS) {
      throw new ValidationError(`At most ${MAX_IDS} versions can be deleted at once.`);
    }
    if (!ids.every((id) => typeof id === 'string' && id)) {
      throw new ValidationError('Version ids must be strings.');
    }
    wanted = [...new Set(ids)];
  }

  const belongs = new Set(kept.map((version) => version.id));
  const items = [];
  for (const id of wanted) {
    if (!belongs.has(id)) {
      items.push({ id, status: 'not-found' });
      continue;
    }
    try {
      const outcome = await operations.purgeVersion(id);
      items.push({ id, status: outcome.status === 'unavailable' ? 'pending' : outcome.status });
    } catch (error) {
      logger.warn({ err: error, versionId: id }, 'A version could not be deleted');
      items.push({ id, status: 'failed' });
    }
  }

  const left = store.listVersionsOfFile(db, file.id, {
    states: ['capturing', 'kept', 'purging'],
  });
  if (left.length === 0 && file.state !== 'live') store.deleteFile(db, file.id);

  return {
    items,
    deleted: items.filter((item) => item.status === 'purged' || item.status === 'pending').length,
    remaining: store.listVersionsOfFile(db, file.id).length,
  };
};

module.exports = {
  rightsFrom,
  marksForFolder,
  listVersions,
  locateVersion,
  downloadVersion,
  readVersionText,
  restoreVersion,
  copyVersionTo,
  replaceWithVersion,
  updateVersion,
  deleteVersions,
  listFilesWithVersions,
  readFileVersions,
  deleteFileVersions,
};
