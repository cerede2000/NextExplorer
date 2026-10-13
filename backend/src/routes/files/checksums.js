const fs = require('node:fs/promises');
const path = require('node:path');

const asyncHandler = require('../../utils/asyncHandler');
const { sanitizeClientMessage } = require('../../middleware/errorHandler');
const { streamAsTask } = require('../../utils/taskStream');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const { combineRelativePath, normalizeRelativePath } = require('../../utils/pathUtils');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const checksums = require('../../services/checksums');

const router = require('express').Router();

/**
 * What a file's bytes add up to.
 *
 * Asked for rather than offered: a checksum is minutes of reading on a large
 * file, so nothing here happens because a panel was opened. What it is for is
 * the question somebody arrives with — "is this the file that page published",
 * "are these two copies the same" — and the answer is remembered, because a
 * hash is only worth taking once (see `services/checksums` for why remembering
 * it cannot be made safe by cleaning it, and is made safe by the key instead).
 *
 * Reading the bytes is what a reader may do with a file they may read, so this
 * is behind the same check as a preview or a download — no more, and no less.
 */
const resolveFile = async (req, item) => {
  const combined = combineRelativePath(item?.path || '', item?.name || '');
  const relativePath = normalizeRelativePath(combined);
  if (!relativePath) throw new ValidationError('A file is required.');

  const context = { user: req.user, guestSession: req.guestSession };
  const { allowed, accessInfo, resolved } = await authorizeAndResolve(
    context,
    relativePath,
    ACTIONS.read
  );
  if (!allowed || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Cannot read that file.');
  }

  const stats = await fs.stat(resolved.absolutePath).catch(() => null);
  if (!stats) throw new NotFoundError('File not found.');
  // A folder has no checksum: what one would mean is a format nobody agrees
  // on, and saying so is better than answering something made up.
  if (!stats.isFile()) throw new ValidationError('Only files have checksums.');

  return {
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    name: path.posix.basename(resolved.relativePath),
    size: stats.size,
  };
};

/**
 * What is already known about a file, and nothing more.
 *
 * The panel asks this when it opens: an answer means the bytes were read once
 * before and have not changed since, and no answer means nobody has asked for
 * them to be read. It never reads a file itself — that is the other address,
 * and it is a decision somebody makes.
 */
router.get(
  '/files/checksums',
  asyncHandler(async (req, res) => {
    const file = await resolveFile(req, { path: '', name: String(req.query?.path || '') });
    const stats = await fs.stat(file.absolutePath);
    const known = await checksums.remembered({ absolutePath: file.absolutePath, stats });

    res.json({
      path: file.relativePath,
      name: file.name,
      size: file.size,
      algorithms: checksums.ALGORITHMS,
      digests: known?.digests || null,
      computedAt: known?.computedAt || null,
    });
  })
);

/**
 * Read these files and answer what they add up to.
 *
 * A registered operation, because this is the slowest thing the application
 * does to a file it is not moving: it reports as it reads, it can be stopped,
 * and closing the tab no longer loses twenty minutes of reading. What it
 * already knows it does not read again.
 *
 * With `compare`, the answer also says whether the files are the same — and
 * takes the shortcut the question allows: two files of different sizes are
 * different, and proving it by reading eighty gigabytes would be absurd.
 */
router.post(
  '/files/checksums',
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw new ValidationError('At least one file is required.');
    const compare = req.body?.compare === true;

    const files = [];
    for (const item of items) files.push(await resolveFile(req, item));

    const answer = { items: [], identical: null };
    const sizes = new Set(files.map((file) => file.size));
    const sizesDiffer = compare && files.length > 1 && sizes.size > 1;

    streamAsTask(req, res, {
      kind: 'checksum',
      destination: '',
      // The name of the one file, where there is one. For several there is no
      // name to give, and a count passed off as a name is drawn as one: the
      // client counts the files itself, from the totals the task carries.
      label: files.length === 1 ? files[0].name : '',
      bag: answer,
      collect: () => ({ ...answer }),
      describeError: (error) => ({
        message: sanitizeClientMessage(error?.message || 'The checksum failed.'),
        code: error?.code || 'CHECKSUM_FAILED',
      }),
      work: async (task) => {
        if (sizesDiffer) {
          // Nothing to read: the sizes already answer the question that was
          // asked, and the files keep whatever digests they already had.
          answer.identical = false;
          answer.because = 'size';
          answer.items = files.map(({ name, relativePath, size }) => ({
            path: relativePath,
            name,
            size,
            digests: null,
          }));
          return;
        }

        task.grow({
          totalItems: files.length,
          totalBytes: files.reduce((total, file) => total + file.size, 0),
          names: files.map((file) => file.relativePath),
        });

        for (const file of files) {
          const { digests, changedWhileReading } = await checksums.digestsOf({
            absolutePath: file.absolutePath,
            signal: task.signal,
            onProgress: (read) => task.report({ unitBytes: read, currentName: file.name }),
          });
          answer.items.push({
            path: file.relativePath,
            name: file.name,
            size: file.size,
            digests,
            ...(changedWhileReading ? { changedWhileReading: true } : {}),
          });
          task.advance({ items: 1, bytes: file.size });
        }

        if (compare && answer.items.length > 1) {
          const [first] = answer.items;
          answer.identical = answer.items.every(
            (entry) => entry.digests?.sha256 && entry.digests.sha256 === first.digests?.sha256
          );
        }
      },
    });
  })
);

module.exports = router;
