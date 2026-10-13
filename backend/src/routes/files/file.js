const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath, ensureValidName, splitName } = require('../../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const folderSizeHooks = require('../../services/folderSizeHooks');
const asyncHandler = require('../../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const { buildItemMetadata } = require('./utils');

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
 * What a new document can be created as.
 *
 * The office formats start from ONLYOFFICE's own blank templates rather than
 * from something assembled here: a hand-written OOXML package is only nearly
 * valid, and the editors disagree about which near-misses they will repair.
 *
 * The text formats need no template — an empty .txt is a valid .txt, unlike an
 * empty .docx — but they belong on the same route because everything else about
 * creating them is identical. `csv` is kept although nothing offers it any
 * more: a caller asking for it is asking for an empty file called `.csv`, which
 * is exactly what it has always answered, and `txt` with an extension of `csv`
 * now says the same thing.
 */
const DOCUMENT_TEMPLATES = {
  docx: { file: 'new.docx', fallbackName: 'Document.docx' },
  xlsx: { file: 'new.xlsx', fallbackName: 'Spreadsheet.xlsx' },
  pptx: { file: 'new.pptx', fallbackName: 'Presentation.pptx' },
  pdf: { file: 'new.pdf', fallbackName: 'Document.pdf' },
  txt: { file: null, fallbackName: 'Document.txt' },
  md: { file: null, fallbackName: 'Document.md' },
  csv: { file: null, fallbackName: 'Data.csv' },
};

/**
 * An extension somebody typed: letters and digits in runs, joined by a dot, a
 * hyphen or an underscore, so `json`, `tar.gz` and `d.ts` all pass and nothing
 * carrying a path separator, a leading dot or a space does.
 *
 * Case is kept as it was typed. Whoever asks for `.SQL` gets `.SQL`; what is
 * compared against the name is folded, so `report.SQL` does not become
 * `report.SQL.sql`.
 */
const EXTENSION_PATTERN = /^[A-Za-z0-9]+(?:[.\-_][A-Za-z0-9]+)*$/;
const MAX_EXTENSION_LENGTH = 20;

const templateDirectory = path.join(__dirname, '..', '..', 'assets', 'office-templates');

/** "Document.txt" without its extension, so a chosen one can take its place. */
const nameWithoutExtension = (fallbackName) => fallbackName.replace(/\.[^.]*$/, '');

/**
 * The extension a new document is to carry.
 *
 * Absent, it is the format's own. Given, it is the caller's — but only where
 * the format has no template to disagree with, and only in the shape an
 * extension can take. Given as an empty string it is nothing at all, which is
 * a file with no extension.
 */
const chosenExtension = (raw, format, template) => {
  if (typeof raw !== 'string') return format;

  const asked = raw.trim().replace(/^\.+/, '');
  if (template.file) {
    if (!asked || asked.toLowerCase() !== format) {
      throw new ValidationError(
        `A ${format} document is made from a template, so its extension cannot be changed.`
      );
    }
    return format;
  }

  if (!asked) return '';
  if (asked.length > MAX_EXTENSION_LENGTH || !EXTENSION_PATTERN.test(asked)) {
    throw new ValidationError(
      'An extension may hold only letters and digits, joined by a dot, a hyphen or an underscore.'
    );
  }
  return asked;
};

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
 * Create a blank document of a known type, ready to be opened in an editor.
 *
 * Separate from the empty-file route above because the two differ in what they
 * produce, not in how they are called: a zero-byte `.docx` is not a document an
 * editor will open, it is a file an editor will refuse.
 *
 * The extension comes from the request, never from the name. A name that
 * already ends in it is left alone; anything else keeps what the caller typed
 * and gains the extension, so "Budget 2026.v2" stays recognisable.
 *
 * `extension` says which, and is only the caller's to choose where the format
 * has no template: an empty file is an empty file whatever it is called, so
 * `.json`, `.yml`, `.sh` or `.conf` are all the same request as `.txt` — and
 * the text editor opens fifty extensions, where this route used to offer three.
 * An empty one means no extension at all, which is how `Dockerfile` is asked
 * for. Where there *is* a template the extension is refused: the bytes are an
 * OOXML package or a PDF, and a name that disagrees with them is a file no
 * editor opens, which is the one thing this route exists to prevent.
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

    const template = DOCUMENT_TEMPLATES[format];
    if (!template) {
      throw new ValidationError(
        `Unsupported document format. Expected one of: ${Object.keys(DOCUMENT_TEMPLATES).join(', ')}.`
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
    const extension = chosenExtension(req.body?.extension, format, template);
    const suffix = extension ? `.${extension}` : '';
    const withExtension = requested
      ? !suffix || requested.toLowerCase().endsWith(suffix.toLowerCase())
        ? requested
        : `${requested}${suffix}`
      : extension === format
        ? template.fallbackName
        : `${nameWithoutExtension(template.fallbackName)}${suffix}`;
    const baseName = ensureValidName(withExtension);

    const contents = template.file
      ? await fs.readFile(path.join(templateDirectory, template.file))
      : null;
    const { absolutePath, finalName } = await createUniqueFile(
      resolved.absolutePath,
      baseName,
      contents
    );
    if (contents) await folderSizeHooks.onFileWritten(absolutePath, contents.length);

    const item = await buildItemMetadata(absolutePath, parentRelative, finalName);
    res.status(201).json({ success: true, item });
  })
);

module.exports = router;
