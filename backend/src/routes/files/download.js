const path = require('path');
const fs = require('fs/promises');
const { ZipArchive } = require('archiver');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { resolvePathWithAccess } = require('../../services/accessManager');
const activityLog = require('../../services/activityLog');
const { trackShareDownload } = require('../../services/sharesService');
const { createPlan, readPlan, ownerKeyFor } = require('../../services/downloadPlans');
const asyncHandler = require('../../utils/asyncHandler');
const { mapWithConcurrency } = require('../../utils/mapWithConcurrency');
const { collectArchiveEntries, appendEntries } = require('../../services/archiveTree');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { collectInputPaths, encodeContentDisposition, stripBasePath, toPosix } = require('./utils');

const router = require('express').Router();
const { clientAddress } = require('../../utils/clientAddress');

const getLogicalSegments = (relativePath = '') => toPosix(relativePath).split('/').filter(Boolean);

const isShareRootPath = (relativePath = '') => {
  const segments = getLogicalSegments(relativePath);
  return segments.length === 2 && segments[0] === 'share';
};

const getDownloadBaseName = ({ relativePath, absolutePath }) => {
  if (isShareRootPath(relativePath)) {
    return path.basename(absolutePath);
  }

  const segments = getLogicalSegments(relativePath);
  return segments[segments.length - 1] || path.basename(absolutePath);
};

const normalizePaths = (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ValidationError('At least one path is required.');
  }

  const normalizedPaths = [
    ...new Set(paths.map((item) => normalizeRelativePath(item)).filter(Boolean)),
  ];
  if (normalizedPaths.length === 0) {
    throw new ValidationError('No valid paths provided.');
  }

  return normalizedPaths;
};

/**
 * Each path resolved and checked, or nothing at all.
 *
 * Every way out of this route goes through here, including the parts of a plan
 * made minutes ago: a plan is a record of what was asked, never a permission
 * that outlives the check.
 */
const resolveTargets = async (context, normalizedPaths) =>
  // The list came in the request, so the number of resolutions in flight is
  // not the client's to choose.
  mapWithConcurrency(normalizedPaths, async (relativePath) => {
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

    if (
      !accessInfo ||
      !accessInfo.canAccess ||
      !accessInfo.canRead ||
      !accessInfo.canDownload ||
      !resolved
    ) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Download not allowed.');
    }

    const { absolutePath, relativePath: logicalPath } = resolved;
    const stats = await fs.stat(absolutePath);
    const shareId = resolved.shareInfo?.sharingType === 'anyone' ? resolved.shareInfo.id : null;
    return { relativePath: logicalPath, absolutePath, stats, shareId };
  });

/**
 * A public link's own counter, for a download that came through the files
 * route rather than the share one: the same fetch, reached by a different
 * address, and a last-downloaded date that skipped it was simply wrong.
 */
const countShareDownloads = async (targets, req) => {
  const shareDownloadIds = [...new Set(targets.map(({ shareId }) => shareId).filter(Boolean))];
  await mapWithConcurrency(shareDownloadIds, (shareId) =>
    trackShareDownload(shareId, { ipAddress: clientAddress(req) })
  );
};

/**
 * What left, named once for the whole request: a selection is one download to
 * the person who asked for it, whatever it becomes on the way out — one file,
 * one archive, or a folder of files the browser wrote itself.
 */
const recordDownload = (targets, req) =>
  activityLog.record({
    action: 'file.download',
    user: req.user,
    target: targets[0].relativePath,
    detail: targets.length > 1 ? { items: targets.length } : null,
    req,
  });

const sendSingleFile = (res, absolutePath, filename) => {
  // Allow dotfiles to be downloaded (by default Express blocks them)
  res.download(absolutePath, filename, { dotfiles: 'allow' }, (err) => {
    if (err) {
      logger.error({ err }, 'Download failed');
      if (!res.headersSent) {
        res.status(500).send('Failed to download file.');
      }
    }
  });
};

const singleFileName = (target, baseNormalized) => {
  const { absolutePath, relativePath } = target;
  if (!baseNormalized) {
    return path.basename(absolutePath);
  }

  const relativePosix = stripBasePath(relativePath, baseNormalized);
  const basename = relativePosix.split('/').pop();
  return basename || path.basename(absolutePath);
};

const archiveNameFor = (targets, baseNormalized) => {
  if (targets.length === 1) {
    const baseName = getDownloadBaseName(targets[0]);
    return `${baseName || 'download'}.zip`;
  }

  if (baseNormalized) {
    const segments = baseNormalized.split(path.sep).filter(Boolean);
    const baseName = segments.length > 0 ? segments[segments.length - 1] : baseNormalized;
    if (baseName) {
      return `${baseName}.zip`;
    }
  }

  return 'download.zip';
};

const sendArchive = async ({ context, res, targets, baseNormalized, archiveName }) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', encodeContentDisposition(archiveName));

  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('error', (archiveError) => {
    logger.error({ err: archiveError }, 'Archive creation failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive.' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  // Only what a listing of those folders would show: never a personal root
  // inside the volume, a name listings leave out, or a path an access rule hides.
  const { entries } = await collectArchiveEntries(
    context,
    targets.map(({ relativePath, absolutePath, stats }) => {
      const entryNameRaw = isShareRootPath(relativePath)
        ? getDownloadBaseName({ relativePath, absolutePath })
        : stripBasePath(relativePath, baseNormalized);
      const entryName = entryNameRaw
        ? entryNameRaw.replace(/\\/g, '/').replace(/^\/+/, '')
        : path.basename(absolutePath);
      return { absolutePath, logicalPath: relativePath, entryName, stats };
    })
  );
  appendEntries(archive, entries);

  await archive.finalize();
};

const handleDownloadRequest = async (paths, req, res, basePath = '') => {
  const normalizedPaths = normalizePaths(paths);
  const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';
  const context = { user: req.user, guestSession: req.guestSession };

  const targets = await resolveTargets(context, normalizedPaths);

  await countShareDownloads(targets, req);
  await recordDownload(targets, req);

  const hasDirectory = targets.some(({ stats }) => stats.isDirectory());
  const shouldArchive = hasDirectory || targets.length > 1;

  if (!shouldArchive) {
    const [target] = targets;
    sendSingleFile(res, target.absolutePath, singleFileName(target, baseNormalized));
    return;
  }

  await sendArchive({
    context,
    res,
    targets,
    baseNormalized,
    archiveName: archiveNameFor(targets, baseNormalized),
  });
};

router.post(
  '/download',
  asyncHandler(async (req, res) => {
    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);
    await handleDownloadRequest(paths, req, res, basePath);
  })
);

/**
 * The same selection, described rather than sent (#487).
 *
 * Answers what the browser needs to take the files one by one — their names and
 * their sizes — and carries the counting and the log entry that the parts then
 * do not repeat. Folders are not split: they stay one archive alongside the
 * loose files, because a folder taken apart is a folder lost.
 */
router.post(
  '/download/plan',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    if (!ownerKey) throw new ForbiddenError('Download not allowed.');

    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);
    const normalizedPaths = normalizePaths(paths);
    const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';
    const context = { user: req.user, guestSession: req.guestSession };

    const targets = await resolveTargets(context, normalizedPaths);

    await countShareDownloads(targets, req);
    await recordDownload(targets, req);

    const fileTargets = targets.filter(({ stats }) => !stats.isDirectory());
    const directoryTargets = targets.filter(({ stats }) => stats.isDirectory());

    const token = createPlan({
      ownerKey,
      basePath: baseNormalized,
      files: fileTargets.map((target) => ({
        relativePath: target.relativePath,
        name: singleFileName(target, baseNormalized),
        size: target.stats.size,
      })),
      archive: directoryTargets.length
        ? {
            name: archiveNameFor(directoryTargets, baseNormalized),
            relativePaths: directoryTargets.map(({ relativePath }) => relativePath),
          }
        : null,
    });

    const plan = readPlan(token, ownerKey);

    res.json({
      token,
      files: plan.files.map(({ name, size }, index) => ({ index, name, size })),
      archive: plan.archive ? { name: plan.archive.name, folders: directoryTargets.length } : null,
    });
  })
);

/**
 * One part of a plan: a file by its position, or the archive holding the
 * folders that were selected with it.
 *
 * Reachable with a plain GET so the browser streams it straight to disk — an
 * anchor with `download`, or a writable file handle — instead of the page
 * holding a whole file in memory first.
 */
router.get(
  '/download/part/:token/:part',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    const plan = ownerKey ? readPlan(req.params.token, ownerKey) : null;
    if (!plan) throw new NotFoundError('This download is no longer available.');

    const context = { user: req.user, guestSession: req.guestSession };
    const { part } = req.params;

    if (part === 'archive') {
      if (!plan.archive) throw new NotFoundError('This download has no archive.');
      const targets = await resolveTargets(context, plan.archive.relativePaths);
      await sendArchive({
        context,
        res,
        targets,
        baseNormalized: plan.basePath,
        archiveName: plan.archive.name,
      });
      return;
    }

    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= plan.files.length) {
      throw new NotFoundError('This download has no such part.');
    }

    const wanted = plan.files[index];
    const [target] = await resolveTargets(context, [wanted.relativePath]);
    if (target.stats.isDirectory()) {
      throw new ValidationError('That part is a folder.');
    }

    sendSingleFile(res, target.absolutePath, wanted.name);
  })
);

module.exports = router;
