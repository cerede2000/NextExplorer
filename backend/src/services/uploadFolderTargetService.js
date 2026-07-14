const path = require('path');

const { ensureDir, pathExists } = require('../utils/fsUtils');
const { findAvailableName, normalizeRelativePath } = require('../utils/pathUtils');

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
  if (!validBatchId(uploadBatchId) || parts.length < 2) return normalized;

  cleanExpiredTargets();
  const sourceRoot = parts[0];
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
  resolveFolderUploadRelativePath,
};
