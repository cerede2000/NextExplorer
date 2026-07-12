const express = require('express');
const { normalizeRelativePath, parsePathSpace, resolveVolumePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { getDb } = require('../services/db');
const folderSizeIndex = require('../services/folderSizeIndex');
const { getVolumeScope } = require('../services/folderSizeIndexer');
const folderSizeManager = require('../services/folderSizeManager');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_BATCH_PATHS = 500;

/**
 * Resolve the absolute filesystem path for a logical path *without* enforcing
 * the navigation ACL — used so a folder's size can still be reported when the
 * user is not allowed to enter it (the non-negotiable requirement of the
 * feature). Only volume-space paths are resolvable this way; personal/share
 * spaces need user context and are left to the access-checked resolution.
 * Returns null when the path cannot be resolved safely.
 */
const fallbackAbsolutePath = (inputRel) => {
  try {
    const { space, rel } = parsePathSpace(inputRel);
    if (space !== 'volume') return null;
    return resolveVolumePath(rel);
  } catch {
    return null;
  }
};

/**
 * Look up a single logical path in the index. Never triggers a filesystem
 * traversal: it reads the pre-computed entry (or reports indexed:false).
 */
const lookupFolderSize = async (context, inputRelRaw) => {
  const inputRel = normalizeRelativePath(inputRelRaw);
  const { accessInfo, resolved } = await resolvePathWithAccess(context, inputRel);
  const canEnter = Boolean(accessInfo && accessInfo.canAccess && accessInfo.canRead);

  // Prefer the access-checked absolute path; fall back to a volume-root
  // resolution so size is available even when navigation is denied.
  const absolutePath = resolved?.absolutePath ?? fallbackAbsolutePath(inputRel);

  const db = await getDb();
  const scope = getVolumeScope();
  const withinRoot = Boolean(absolutePath && folderSizeIndex.isWithinRoot(scope.root, absolutePath));
  const entry = withinRoot ? folderSizeIndex.getByAbsolutePath(db, absolutePath) : null;

  return {
    result: {
      path: resolved?.relativePath ?? inputRel,
      canEnter,
      sizeBytes: entry ? entry.sizeBytes : null,
      entryCount: entry ? entry.entryCount : null,
      lastUpdated: entry ? entry.lastDeltaAt || entry.lastFullScanAt || null : null,
      indexed: Boolean(entry),
    },
    // Absolute path (volume-space, within root) for the on-view refresh, or null.
    absolutePath: withinRoot ? absolutePath : null,
  };
};

/**
 * Fire-and-forget on-view refresh: ask the indexer to re-check these folders'
 * mtime in the background so external changes surface within seconds. Never
 * blocks or fails the response.
 */
const scheduleOnViewRefresh = (absolutePaths) => {
  const dirs = absolutePaths.filter(Boolean);
  if (!dirs.length) return;
  Promise.resolve(folderSizeManager.touch(dirs)).catch(() => {});
};

// GET /api/folder-size/<logical path>
// Returns the pre-computed recursive size for a single folder. `sizeBytes` is
// returned regardless of `canEnter`; `indexed:false` (not a 500) when the path
// is not yet in the index.
router.get(
  '/folder-size/*',
  asyncHandler(async (req, res) => {
    const raw = req.params[0] || '';
    const context = { user: req.user, guestSession: req.guestSession };
    const { result, absolutePath } = await lookupFolderSize(context, raw);
    res.json(result);
    scheduleOnViewRefresh([absolutePath]);
  })
);

// POST /api/folder-size/batch  { paths: ["a", "a/b", ...] }
// One index lookup per requested path so a list view can be populated without
// N separate round trips.
router.post(
  '/folder-size/batch',
  asyncHandler(async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const limited = paths.slice(0, MAX_BATCH_PATHS);
    const context = { user: req.user, guestSession: req.guestSession };

    const results = [];
    const touchPaths = [];
    for (const p of limited) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { result, absolutePath } = await lookupFolderSize(context, typeof p === 'string' ? p : '');
        results.push(result);
        if (absolutePath) touchPaths.push(absolutePath);
      } catch (err) {
        logger.debug({ err, path: p }, 'folder-size batch lookup failed for path');
        results.push({
          path: typeof p === 'string' ? p : '',
          canEnter: false,
          sizeBytes: null,
          entryCount: null,
          lastUpdated: null,
          indexed: false,
        });
      }
    }

    res.json({ results, truncated: paths.length > limited.length });
    scheduleOnViewRefresh(touchPaths);
  })
);

module.exports = router;
