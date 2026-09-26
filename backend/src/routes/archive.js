const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const { track: trackInFlight } = require('../services/inFlightFiles');
const { removeInventoried } = require('../utils/ownedTree');
const { mapWithConcurrency } = require('../utils/mapWithConcurrency');
const { startNdjsonStream, throttlePercent } = require('../utils/ndjsonStream');
const { sanitizeClientMessage } = require('../middleware/errorHandler');
const { ensureStorageAvailable } = require('../services/uploadStorageGuard');
const {
  ensureArchiveWithinLimits,
  extractIntoCurrentFolder,
} = require('../services/archiveExtraction');
const { extractArchiveEntries } = require('../services/archiveService');
const { getSupportedArchiveExtensions } = require('../services/archiveService');
const {
  browseArchive,
  findArchiveEntry,
  readArchiveEntry,
  readBrowsableArchive,
  entryPathOf,
} = require('../services/archiveBrowseService');
const { toExtension, resolveMimeType } = require('../utils/fileTypes');
const { encodeContentDisposition } = require('./files/utils');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');

const router = express.Router();

/**
 * Looking inside an archive, without unpacking it.
 *
 * The address of the archive is a real path on disk, and the position inside
 * it is a separate parameter. Not one virtual path like
 * `/Work/pack.zip/inner/file`: twenty-six files resolve a path and every one
 * of them takes what comes back for a real file — renaming, deleting,
 * uploading, thumbnails, shares, folder sizes, the search index. Teaching all
 * of them a second kind of path is where the holes would be. Here the archive
 * goes through the same resolution as any other file, and what is inside it
 * never leaves this route.
 */

/** The archive named by the request, once the caller is allowed to read it. */
const resolveArchive = async (req, named = req.query.path) => {
  const relativePath = normalizeRelativePath(typeof named === 'string' ? named : '');
  if (!relativePath) {
    throw new ValidationError('The path of an archive is required.');
  }

  const context = { user: req.user, guestSession: req.guestSession };
  let accessInfo;
  let resolved;
  try {
    ({ accessInfo, resolved } = await resolvePathWithAccess(context, relativePath));
  } catch (_) {
    throw new NotFoundError('Path not found.');
  }

  if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Path is not accessible.');
  }

  let stats;
  try {
    stats = await fs.stat(resolved.absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new NotFoundError('Path not found.');
    throw error;
  }
  if (!stats.isFile()) {
    throw new ValidationError('That is not an archive.');
  }

  // Only what this build of 7-Zip can actually read, and only what the
  // configuration offers as an archive: the same list extraction is held to,
  // so nothing is browsable that could not then be extracted.
  const extension = path.extname(resolved.relativePath).slice(1).toLowerCase();
  const supported = await getSupportedArchiveExtensions();
  if (!supported.includes(extension)) {
    throw new ValidationError('That kind of file cannot be opened as an archive.');
  }

  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
};

router.get(
  '/archive/list',
  asyncHandler(async (req, res) => {
    const archive = await resolveArchive(req);
    const inside = typeof req.query.inside === 'string' ? req.query.inside : '';

    const listing = await browseArchive(archive.absolutePath, inside);

    return res.json({
      path: archive.relativePath,
      name: path.basename(archive.relativePath),
      ...listing,
    });
  })
);

/**
 * One file out of an archive, without unpacking the rest of it.
 *
 * Always as an attachment. A file inside somebody's archive is somebody else's
 * HTML as easily as their photograph, and served inline it would run on this
 * application's origin: that is a decision about previewing, not about reading,
 * and it is not made here. The type is still declared, so a saved file arrives
 * named and typed as what it is, and `nosniff` stops the browser arguing.
 */
router.get(
  '/archive/entry',
  asyncHandler(async (req, res) => {
    const archive = await resolveArchive(req);
    const wanted = typeof req.query.entry === 'string' ? req.query.entry : '';
    // `source` is the archive the entry is actually read from, which for a
    // compound one is the decompressed copy rather than the file on the volume.
    const found = await findArchiveEntry(archive.absolutePath, wanted);
    const { entry } = found;

    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    res.setHeader('Content-Type', resolveMimeType(toExtension(name)));
    res.setHeader('Content-Disposition', encodeContentDisposition(name, 'attachment'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    // What the archive says the entry weighs, which is what `-so` writes. A
    // damaged archive that writes less ends the download short, which is what
    // it is, rather than looking like a file that arrived whole.
    if (Number.isFinite(entry.size)) res.setHeader('Content-Length', String(entry.size));

    // From the archive, or from the tree a solid one was extracted into.
    const reading = await readArchiveEntry(found);

    // Whoever closed the tab is not waiting for the rest of it, and 7-Zip would
    // otherwise go on decompressing into a pipe nobody reads.
    res.once('close', () => {
      if (!res.writableEnded) reading.stop();
    });

    reading.stdout.pipe(res);

    try {
      await reading.finished;
    } catch (error) {
      reading.stop();
      if (res.headersSent) {
        // The answer was already on its way: there is no status left to send,
        // and ending it short is the only honest thing available.
        logger.warn({ err: error, entry: entry.path }, 'Reading an archive entry stopped short');
        res.destroy();
        return;
      }
      throw error;
    }
  })
);

/**
 * Take some of an archive out onto the volume, without unpacking the rest.
 *
 * The other half of looking inside one: a folder of photographs in a backup is
 * found here and wanted *there*, and downloading it and putting it back is not
 * an answer on a server somebody reaches from a phone.
 *
 * What comes out goes into the folder the archive is in unless the body names
 * another one, which is the folder somebody picked in the dialog. A named
 * destination is not a shortcut around anything: it is authorized exactly like
 * the default is, so the answer to "may I write here" is the same whoever asks
 * and wherever they point.
 */
router.post(
  '/archive/extract',
  asyncHandler(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);

    const archive = await resolveArchive(req, req.body?.path);
    const asked = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (asked.length === 0) {
      throw new ValidationError('At least one entry is required.');
    }

    // The folder the archive is in, and the right to write in it. Read on the
    // archive is not enough: what comes out of it is a new file on somebody's
    // volume, and a folder an administrator made read-only stays read-only.
    const context = { user: req.user, guestSession: req.guestSession };
    const asDestination = typeof req.body?.destination === 'string' ? req.body.destination : '';
    const destinationRelativePath = normalizeRelativePath(
      asDestination.trim() ? asDestination : path.posix.dirname(archive.relativePath || '')
    );
    for (const action of [ACTIONS.createFolder, ACTIONS.createFile]) {
      const { allowed, accessInfo } = await authorizeAndResolve(
        context,
        destinationRelativePath,
        action
      );
      if (!allowed) {
        throw new ForbiddenError(accessInfo?.denialReason || 'Destination is read-only.');
      }
    }
    const { resolved: destinationResolved } = await authorizeAndResolve(
      context,
      destinationRelativePath,
      ACTIONS.createFile
    );
    const destinationAbsolutePath = destinationResolved?.absolutePath;
    if (!destinationAbsolutePath) throw new ForbiddenError('Cannot resolve destination folder.');

    // A folder that is not there, or is not a folder, is said plainly here: the
    // first thing the extraction does is create a staging directory inside it,
    // and that failure arrives halfway through a stream of progress events.
    const destinationStat = await fs.stat(destinationAbsolutePath).catch(() => null);
    if (!destinationStat?.isDirectory()) {
      throw new NotFoundError('That destination folder does not exist.');
    }

    const { source, listing } = await readBrowsableArchive(archive.absolutePath);

    // Each name is looked up in the listing rather than taken on trust, and a
    // folder stands for everything under it: what is extracted is entries this
    // archive holds, named as it names them.
    const selected = new Map();
    for (const name of asked) {
      const wanted = entryPathOf(typeof name === 'string' ? name : '');
      if (wanted === null) {
        throw new ValidationError('That is not something inside this archive.');
      }
      const under = listing.entries.filter(
        (entry) => entry.path === wanted || entry.path.startsWith(`${wanted}/`)
      );
      if (under.length === 0) {
        throw new NotFoundError('That is not in this archive.');
      }
      for (const entry of under) selected.set(entry.path, entry);
    }

    const chosen = [...selected.values()];
    if (chosen.some((entry) => entry.encrypted)) {
      throw new ForbiddenError(
        'This file is encrypted and cannot be extracted without its password.'
      );
    }

    const totalBytes = chosen.reduce((sum, entry) => sum + (entry.size || 0), 0);
    ensureArchiveWithinLimits({ entryCount: chosen.length, totalBytes });
    await ensureStorageAvailable(destinationAbsolutePath, totalBytes, 'destination storage');

    // Written into a hidden folder of its own first, and moved out of it only
    // once whole: a name that appears on the volume meanwhile is never replaced,
    // and a failure has nothing of its own under a real name to take back.
    const stagingAbsolutePath = await fs.mkdtemp(
      path.join(destinationAbsolutePath, '.nextexplorer-extract-')
    );
    const movedPaths = [];
    const inFlight = trackInFlight(stagingAbsolutePath, 'staging-directory');

    // Everything above throws before a byte is written, so a refusal is still an
    // ordinary HTTP error. From here the answer is the same stream of events the
    // other archive operations write.
    const writeEvent = startNdjsonStream(res);
    writeEvent({ type: 'start', name: path.posix.basename(chosen[0].path) });
    const onPercent = throttlePercent(writeEvent);

    try {
      await extractArchiveEntries(
        source,
        stagingAbsolutePath,
        chosen.map((entry) => entry.path),
        onPercent,
        { signal: controller.signal }
      );

      const items = await extractIntoCurrentFolder({
        stagingDirectory: stagingAbsolutePath,
        destinationDirectory: destinationAbsolutePath,
        relativeParentPath: destinationRelativePath,
        movedPaths,
      });
      // The staging directory is this route's own, created a moment ago under
      // the cache: it never holds anything anybody put there, so it does not
      // go through the trash.
      // eslint-disable-next-line no-restricted-properties
      await fs.rm(stagingAbsolutePath, { recursive: true, force: true });
      writeEvent({
        type: 'done',
        success: true,
        item: items.length === 1 ? items[0] : null,
        items,
      });
    } catch (error) {
      logger.warn(
        { err: error, archive: archive.relativePath },
        'Extracting from an archive failed'
      );
      // eslint-disable-next-line no-restricted-properties
      await fs.rm(stagingAbsolutePath, { recursive: true, force: true });
      // What this placed, and only that: a file somebody saved into a placed
      // folder in the meantime stays, with the folders holding it.
      await mapWithConcurrency(movedPaths, (moved) =>
        removeInventoried(moved.path, moved.inventory)
      );
      writeEvent({
        type: 'error',
        message: sanitizeClientMessage(error.message || 'Extraction failed.'),
        code: error.code || 'EXTRACT_FAILED',
      });
    } finally {
      inFlight.release();
      req.off('aborted', abort);
      res.off('close', onClose);
      res.end();
    }
  })
);

module.exports = router;
