const path = require('path');
const fs = require('fs/promises');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const { findAvailableName, normalizeRelativePath } = require('../utils/pathUtils');
const { ValidationError } = require('../errors/AppError');

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

// `mkdir` is the actual reservation: unlike a check-then-create sequence, it
// stays correct when several browser tabs or application instances start the
// same folder upload at the same time.
const reserveFolderTarget = async ({ destinationRoot, sourceRoot, context }) => {
  const scopeKey = getScopeKey(context);
  const reservationKey = `${scopeKey}\u0000${destinationRoot}\u0000${sourceRoot}`;

  return withReservation(reservationKey, async () => {
    for (let counter = 0; counter < 100000; counter += 1) {
      const targetRoot = nextFolderCandidate(sourceRoot, counter);
      try {
        await fs.mkdir(path.join(destinationRoot, targetRoot));
        return targetRoot;
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw err;
      }
    }
    throw new ValidationError('Could not reserve a unique folder name.');
  });
};

// A folder picker may start dozens of parallel HTTP uploads. Reserve its
// destination before queuing any file and return the final root name. Every
// request then carries the already-resolved relative path, so the outcome does
// not depend on multipart ordering, request affinity, or an in-memory cache.
const reserveFolderUploadTarget = async ({ destinationRoot, sourceRoot, context }) => {
  const normalizedRoot = normalizeFolderRoot(sourceRoot);
  return reserveFolderTarget({
    destinationRoot,
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

    let targetRoot = sourceRoot;
    if (await pathExists(path.join(destinationRoot, targetRoot))) {
      targetRoot = await findAvailableName(destinationRoot, sourceRoot);
    }

    // Reserve before another simultaneous folder batch can select the same name.
    await ensureDir(path.join(destinationRoot, targetRoot));
    folderTargets.set(targetKey, { targetRoot, updatedAt: Date.now() });
    return path.posix.join(targetRoot, ...parts.slice(1));
  });
};

module.exports = {
  reserveFolderUploadTarget,
  resolveFolderUploadRelativePath,
};
