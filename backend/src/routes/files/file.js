const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath, ensureValidName, splitName } = require('../../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const asyncHandler = require('../../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const { buildItemMetadata } = require('./utils');
const folderSizeHooks = require('../../services/folderSizeHooks');

const router = require('express').Router();

/**
 * Create a file nobody else holds, and write `contents` into it.
 *
 * The exclusive open is what makes the name ours: checking first and creating
 * afterwards hands the file to whoever asked in between. Contents are written
 * through the same handle, so a document created from a template is never
 * visible as an empty file — an editor opening in that window would refuse it.
 */
const createUniqueFile = async (parentAbsolute, requestedName, contents = null) => {
  const { base, extension } = splitName(requestedName);

  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const finalName = attempt === 1 ? requestedName : `${base} ${attempt}${extension}`;
    const absolutePath = path.join(parentAbsolute, finalName);

    try {
      const handle = await fs.open(absolutePath, 'wx');
      try {
        if (contents) await handle.write(contents);
      } finally {
        await handle.close();
      }
      return { absolutePath, finalName };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }

  throw new ValidationError('Unable to allocate a unique file name.');
};

/**
 * The blank documents a new office file starts from.
 *
 * Copied from ONLYOFFICE's own templates rather than assembled here: a
 * hand-written OOXML package is only nearly valid, and the editors disagree
 * about which near-misses they will repair.
 */
const OFFICE_TEMPLATES = {
  docx: { file: 'new.docx', fallbackName: 'Document.docx' },
  xlsx: { file: 'new.xlsx', fallbackName: 'Spreadsheet.xlsx' },
  pptx: { file: 'new.pptx', fallbackName: 'Presentation.pptx' },
};

const templateDirectory = path.join(__dirname, '..', '..', 'assets', 'office-templates');

router.post(
  '/files/file',
  asyncHandler(async (req, res) => {
    const destination = req.body?.path ?? req.body?.destination ?? '';
    const requestedName = req.body?.name;
    const parentRelative = normalizeRelativePath(destination);

    if (!parentRelative || parentRelative.trim() === '') {
      throw new ValidationError(
        'Cannot create files in the root path. Please select a specific volume or folder first.'
      );
    }

    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      parentRelative,
      ACTIONS.createFile
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Cannot create files in this path.');
    }

    let parentStats;
    try {
      parentStats = await fs.stat(resolved.absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Destination path does not exist.');
      }
      throw error;
    }

    if (!parentStats.isDirectory()) {
      throw new ValidationError('Destination must be an existing directory.');
    }

    const baseName =
      typeof requestedName === 'string' && requestedName.trim()
        ? ensureValidName(requestedName)
        : 'Untitled.txt';
    const { absolutePath, finalName } = await createUniqueFile(resolved.absolutePath, baseName);
    const item = await buildItemMetadata(absolutePath, parentRelative, finalName);

    res.status(201).json({ success: true, item });
  })
);

/**
 * Create a blank office document, ready to be opened in an editor.
 *
 * Separate from the empty-file route above because the two differ in what they
 * produce, not in how they are called: a zero-byte `.docx` is not a document an
 * editor will open, it is a file an editor will refuse.
 *
 * The extension comes from the requested format, never from the name. A name
 * that already ends in it is left alone; anything else keeps what the caller
 * typed and gains the extension, so "Budget 2026.v2" stays recognisable.
 */
router.post(
  '/files/office-document',
  asyncHandler(async (req, res) => {
    const destination = req.body?.path ?? req.body?.destination ?? '';
    const parentRelative = normalizeRelativePath(destination);
    const format = String(req.body?.format || '').toLowerCase();

    if (!parentRelative || parentRelative.trim() === '') {
      throw new ValidationError(
        'Cannot create files in the root path. Please select a specific volume or folder first.'
      );
    }

    const template = OFFICE_TEMPLATES[format];
    if (!template) {
      throw new ValidationError(
        `Unsupported document format. Expected one of: ${Object.keys(OFFICE_TEMPLATES).join(', ')}.`
      );
    }

    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      parentRelative,
      ACTIONS.createFile
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Cannot create files in this path.');
    }

    let parentStats;
    try {
      parentStats = await fs.stat(resolved.absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError('Destination path does not exist.');
      }
      throw error;
    }
    if (!parentStats.isDirectory()) {
      throw new ValidationError('Destination must be an existing directory.');
    }

    const requested = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const suffix = `.${format}`;
    const withExtension = requested
      ? requested.toLowerCase().endsWith(suffix)
        ? requested
        : `${requested}${suffix}`
      : template.fallbackName;
    const baseName = ensureValidName(withExtension);

    const contents = await fs.readFile(path.join(templateDirectory, template.file));
    const { absolutePath, finalName } = await createUniqueFile(
      resolved.absolutePath,
      baseName,
      contents
    );
    await folderSizeHooks.onFileWritten(absolutePath, contents.length);

    const item = await buildItemMetadata(absolutePath, parentRelative, finalName);
    res.status(201).json({ success: true, item });
  })
);

module.exports = router;
