const path = require('path');
const fs = require('fs/promises');

const { ensureDir } = require('../utils/fsUtils');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('./authorizationService');
const { ForbiddenError, ValidationError } = require('../errors/AppError');

const FOLDER_BATCH_TTL_MS = 6 * 60 * 60 * 1000;
const folderTargets = new Map();
const reservations = new Map();

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
    // eslint-disable-next-line no-await-in-loop
    await assertCandidateAllowed({ logicalBase, candidate: targetRoot, context });
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.mkdir(path.join(destinationRoot, targetRoot));
      return targetRoot;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new ValidationError('Could not reserve a unique folder name.');
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
const reserveFolderUploadTarget = async ({ destinationRoot, logicalBase, sourceRoot, context }) => {
  const normalizedRoot = normalizeFolderRoot(sourceRoot);
  return reserveFolderTarget({
    destinationRoot,
    logicalBase,
    sourceRoot: normalizedRoot,
    context,
  });
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
  const targetKey = `${scopeKey}\u0000${destinationRoot}\u0000${uploadBatchId}\u0000${sourceRoot}`;
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

module.exports = {
  reserveFolderUploadTarget,
  resolveFolderUploadRelativePath,
};
