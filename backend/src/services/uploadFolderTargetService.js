const path = require('path');
const fs = require('fs/promises');

const { ensureDir } = require('../utils/fsUtils');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { ForbiddenError, ValidationError } = require('../errors/AppError');

const FOLDER_BATCH_TTL_MS = 6 * 60 * 60 * 1000;
const folderTargets = new Map();
const reservations = new Map();

/**
 * The folders a reservation created, which are the only ones it may take back.
 *
 * `reserveFolderCandidate` below creates a folder under a name nothing held, so
 * the folder is new and whatever ends up in it came from the drop it was made
 * for. That is what makes giving it back safe, and it is the only thing that
 * does: a folder this server did not create belongs to somebody, however empty
 * it looks. So a removal is offered for an entry of this register and for
 * nothing else.
 *
 * Keyed exactly as the record above is, under the asker's own scope: a batch id
 * is the client's to choose, and a register kept for everybody would let one
 * reader have another reader's folder removed by naming their batch.
 *
 * `identity` is what the filesystem called the folder the moment it was made. A
 * reservation lives for hours, and in that time the folder can be deleted and
 * another one put under the same name — which is a folder nothing here created,
 * sitting at the path this note is about.
 */
const createdFolders = new Map();

const getScopeKey = (context = {}) => {
  if (context.user?.id) return `user:${context.user.id}`;
  if (context.guestSession?.id) return `guest:${context.guestSession.id}`;
  return 'anonymous';
};

const validBatchId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);

const cleanExpiredTargets = (now = Date.now()) => {
  for (const [key, entry] of folderTargets) {
    if (now - entry.updatedAt > FOLDER_BATCH_TTL_MS) folderTargets.delete(key);
  }
};

const cleanExpiredCreatedFolders = (now = Date.now()) => {
  for (const [key, entry] of createdFolders) {
    if (now - entry.createdAt > FOLDER_BATCH_TTL_MS) createdFolders.delete(key);
  }
};

const withReservation = async (key, work) => {
  const previous = reservations.get(key) || Promise.resolve();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => pending);
  reservations.set(key, chain);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (reservations.get(key) === chain) reservations.delete(key);
  }
};

/**
 * The record's key, spelled once.
 *
 * Both roads to a folder read and write it, and a key assembled twice is a key
 * that can differ in one place: the scope keeps one reader's reservation out of
 * another's reach, and dropping it from either spelling would open exactly that.
 */
const targetKeyFor = ({ context, destinationRoot, uploadBatchId, sourceRoot }) =>
  `${getScopeKey(context)}\u0000${destinationRoot}\u0000${uploadBatchId}\u0000${sourceRoot}`;

const normalizeFolderRoot = (value) => {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.includes(path.sep) || normalized.includes('/')) {
    throw new ValidationError('A single top-level folder name is required.');
  }
  return normalized;
};

const nextFolderCandidate = (sourceRoot, counter) =>
  counter === 0 ? sourceRoot : `${sourceRoot} (${counter})`;

// Far past any real destination; a bound so that a name which can never be
// taken ends in an error rather than a loop.
const MAX_FOLDER_CANDIDATES = 100000;

/**
 * Refuse a folder while it is still a name, rather than once it is on disk.
 *
 * The reservation below is the `mkdir` itself, and the folder a file lands in
 * used to be authorized only afterwards, on its way in: an upload refused then
 * had already left an empty folder behind, under a name an administrator had
 * hidden or made read-only. `.nextexplorer` is the worst of them — the name the
 * zone holding deleted files takes, which no path may go through, so a folder
 * created under it cannot be reached again to be removed.
 *
 * @param {string} options.logicalBase the authorized destination, as a logical path
 * @param {string} options.candidate the single folder name about to be created in it
 */
const assertCandidateAllowed = async ({ logicalBase, candidate, context }) => {
  const logicalPath = normalizeRelativePath(path.posix.join(logicalBase || '', candidate));
  const { allowed, accessInfo } = await authorizeAndResolve(context, logicalPath, ACTIONS.upload);
  if (!allowed) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Cannot upload files to this path.');
  }
};

// `mkdir` is the actual reservation: unlike a check-then-create sequence, it
// stays correct when several browser tabs or application instances start the
// same folder upload at the same time. Each candidate is authorized before it
// is attempted, so a name that is refused is never created and then given back.
const reserveFolderCandidate = async ({ destinationRoot, logicalBase, sourceRoot, context }) => {
  for (let counter = 0; counter < MAX_FOLDER_CANDIDATES; counter += 1) {
    const targetRoot = nextFolderCandidate(sourceRoot, counter);
    await assertCandidateAllowed({ logicalBase, candidate: targetRoot, context });
    try {
      await fs.mkdir(path.join(destinationRoot, targetRoot));
      return targetRoot;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new ValidationError('Could not reserve a unique folder name.');
};

/**
 * Note a folder a reservation has just created, so that it can be given back.
 *
 * Identified by what the filesystem says it is rather than by its name, and a
 * note that cannot be taken is not taken: with no identity there is nothing to
 * tell this folder from whatever may sit under its name hours later, and a
 * folder absent from the register is one that is never removed — the harmless
 * outcome of the two.
 */
const rememberCreatedFolder = async ({ key, destinationRoot, logicalBase, targetRoot }) => {
  const absolutePath = path.join(destinationRoot, targetRoot);
  let identity;
  try {
    const stats = await fs.lstat(absolutePath);
    identity = `${stats.dev}:${stats.ino}`;
  } catch (_) {
    return;
  }
  cleanExpiredCreatedFolders();
  createdFolders.set(key, {
    absolutePath,
    logicalPath: normalizeRelativePath(path.posix.join(logicalBase || '', targetRoot)),
    identity,
    createdAt: Date.now(),
  });
};

/**
 * Whether a reserved folder is still holding nothing of anybody's.
 *
 * A file at any depth answers no, and so does anything that is not a folder: a
 * symbolic link, a socket, a device node. What a folder upload makes is folders
 * and files, so anything else in there was put there by something else.
 */
const holdsOnlyFolders = async (absolutePath) => {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!(await holdsOnlyFolders(path.join(absolutePath, entry.name)))) return false;
  }
  return true;
};

/**
 * Remove a tree of empty folders, from the leaves up.
 *
 * `rmdir` rather than a recursive remove, deliberately: the tree was read a
 * moment ago and found to hold no file, and a request that was already on its
 * way can land one in it between that reading and this. `rmdir` refuses a
 * folder that is not empty, so a file arriving in the gap keeps its own folder
 * and every folder above it, where a recursive remove would take the file with
 * them.
 */
const removeEmptyFolderTree = async (absolutePath) => {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!(await removeEmptyFolderTree(path.join(absolutePath, entry.name)))) return false;
  }
  try {
    await fs.rmdir(absolutePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    if (err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST') return false;
    throw err;
  }
  return true;
};

const reserveFolderTarget = async ({ destinationRoot, logicalBase, sourceRoot, context }) => {
  const scopeKey = getScopeKey(context);
  const reservationKey = `${scopeKey}\u0000${destinationRoot}\u0000${sourceRoot}`;

  return withReservation(reservationKey, () =>
    reserveFolderCandidate({ destinationRoot, logicalBase, sourceRoot, context })
  );
};

// A folder picker may start dozens of parallel HTTP uploads. Reserve its
// destination before queuing any file and return the final root name. Every
// request then carries the already-resolved relative path, so the outcome does
// not depend on multipart ordering, request affinity, or an in-memory cache.
//
// And the answer is remembered under the batch it was given for, because a file
// of that batch can still arrive without the resolved path: the client stops
// resolving the moment a reader presses stop, while a request already on its
// way still carries its file. Such a file used to be resolved by the road
// below, which kept a record of its own that this one never wrote to — so it
// reserved a second folder for a batch that already had one, and a cancelled
// drop answered `ardoise` and then `ardoise (1)`. One record, written by
// whichever road asks first.
const reserveFolderUploadTarget = async ({
  destinationRoot,
  logicalBase,
  sourceRoot,
  context,
  uploadBatchId,
}) => {
  const normalizedRoot = normalizeFolderRoot(sourceRoot);
  const targetRoot = await reserveFolderTarget({
    destinationRoot,
    logicalBase,
    sourceRoot: normalizedRoot,
    context,
  });
  // Under the asker's own scope: a batch id is the client's to choose, so a
  // record kept for everybody would let one reader aim their files at a folder
  // reserved under somebody else's name by naming their batch.
  if (validBatchId(uploadBatchId)) {
    const key = targetKeyFor({
      context,
      destinationRoot,
      uploadBatchId,
      sourceRoot: normalizedRoot,
    });
    cleanExpiredTargets();
    folderTargets.set(key, {
      targetRoot,
      updatedAt: Date.now(),
    });
    // And a note of the folder itself, which is the only thing that lets it be
    // given back if the drop it was made for never sends anything.
    await rememberCreatedFolder({ key, destinationRoot, logicalBase, targetRoot });
  }
  return targetRoot;
};

// A folder picker submits one HTTP request per file. Reserve its top-level
// directory once per client batch so a repeated folder upload becomes
// "folder (1)" instead of merging files into the existing folder.
const resolveFolderUploadRelativePath = async ({
  relativePath,
  destinationRoot,
  logicalBase,
  context,
  uploadBatchId,
}) => {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return normalized;

  const sourceRoot = parts[0];
  if (!validBatchId(uploadBatchId)) return normalized;

  cleanExpiredTargets();
  const scopeKey = getScopeKey(context);
  const targetKey = targetKeyFor({ context, destinationRoot, uploadBatchId, sourceRoot });
  const existing = folderTargets.get(targetKey);
  if (existing) {
    existing.updatedAt = Date.now();
    return path.posix.join(existing.targetRoot, ...parts.slice(1));
  }

  const reservationKey = `${scopeKey}\u0000${destinationRoot}\u0000${sourceRoot}`;
  return withReservation(reservationKey, async () => {
    const reserved = folderTargets.get(targetKey);
    if (reserved) {
      reserved.updatedAt = Date.now();
      return path.posix.join(reserved.targetRoot, ...parts.slice(1));
    }

    // The upload's own destination may be created as it always was; the folder
    // it receives is not. A recursive mkdir succeeds on a folder already there,
    // so looking for a free name and creating it afterwards poured this batch
    // into whatever arrived under that name in between — another upload, a copy,
    // a folder made over SMB. A plain mkdir fails on a taken name instead, and
    // moves on to the next one.
    await ensureDir(destinationRoot);
    const targetRoot = await reserveFolderCandidate({
      destinationRoot,
      logicalBase,
      sourceRoot,
      context,
    });
    folderTargets.set(targetKey, { targetRoot, updatedAt: Date.now() });
    return path.posix.join(targetRoot, ...parts.slice(1));
  });
};

/**
 * The folder a batch reserved, given back when nothing arrived in it.
 *
 * Reserving is a `mkdir`, so a drop a reader called off before a byte went out
 * still left a folder behind — and the next drop of the same folder found that
 * name taken and became `ardoise (1)`, then `ardoise (2)`. Somebody trying a
 * few times was left with a row of empty folders and a name that kept moving.
 *
 * What it takes back is one entry of the register above: still where it was
 * put, still the folder that was created there, and holding no file at any
 * depth. Anything else is left exactly as it stands — one file in it is
 * somebody's bytes, and bytes that arrived are worth more than a tidy name.
 *
 * No power beyond the one that made the folder. The path is authorized for
 * upload as it was before the `mkdir`, and the entry is looked up under the
 * asker's own scope, so a reader naming somebody else's batch finds nothing.
 *
 * The record of where the batch's files were going is deliberately left alone.
 * A request already on its way when the reader pressed stop still arrives, and
 * it has to land in the folder this batch was given — made again for it if need
 * be — rather than reserve a second one.
 */
const releaseFolderUploadTarget = async ({
  destinationRoot,
  sourceRoot,
  context,
  uploadBatchId,
}) => {
  if (!validBatchId(uploadBatchId)) return false;
  const normalizedRoot = normalizeFolderRoot(sourceRoot);
  cleanExpiredCreatedFolders();
  const key = targetKeyFor({
    context,
    destinationRoot,
    uploadBatchId,
    sourceRoot: normalizedRoot,
  });
  const entry = createdFolders.get(key);
  if (!entry) return false;

  const { allowed, accessInfo, resolved } = await authorizeAndResolve(
    context,
    entry.logicalPath,
    ACTIONS.upload
  );
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Cannot upload files to this path.');
  }
  // The same name is not the same place: a volume mounted somewhere else under
  // the same logical name leads where this note was never about.
  if (resolved.absolutePath !== entry.absolutePath) return false;

  // Under the lock the names of this folder are chosen behind, so a removal and
  // a reservation never have their hands on the same name at once.
  const reservationKey = `${getScopeKey(context)}\u0000${destinationRoot}\u0000${normalizedRoot}`;
  const removed = await withReservation(reservationKey, async () => {
    let stats;
    try {
      stats = await fs.lstat(entry.absolutePath);
    } catch (err) {
      // Already gone: there is nothing left to give back.
      if (err?.code === 'ENOENT') return true;
      throw err;
    }
    if (!stats.isDirectory()) return false;
    if (`${stats.dev}:${stats.ino}` !== entry.identity) return false;
    if (!(await holdsOnlyFolders(entry.absolutePath))) return false;
    return removeEmptyFolderTree(entry.absolutePath);
  });

  if (removed) createdFolders.delete(key);
  return removed;
};

module.exports = {
  releaseFolderUploadTarget,
  reserveFolderUploadTarget,
  resolveFolderUploadRelativePath,
};
