const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const versions = require('../services/versions/operations');
const folderSizeHooks = require('../services/folderSizeHooks');
const asyncHandler = require('../utils/asyncHandler');
const { sendTextFile } = require('../utils/textFileResponse');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const {
  readFileEncoding,
  encodeText,
  MAX_EDITOR_FILE_SIZE,
} = require('../services/textEditorService');

const router = express.Router();

async function resolveReadableFile(req, relative) {
  if (typeof relative !== 'string' || !relative) {
    throw new ValidationError('A valid file path is required.');
  }

  const relativePath = normalizeRelativePath(relative);
  const context = { user: req.user, guestSession: req.guestSession };

  let accessInfo;
  let resolved;
  try {
    const result = await authorizeAndResolve(context, relativePath, ACTIONS.read);
    if (!result.allowed || !result.resolved) {
      throw new ForbiddenError(result.accessInfo?.denialReason || 'Access denied.');
    }
    accessInfo = result.accessInfo;
    resolved = result.resolved;
  } catch (error) {
    if (error && error.isOperational) {
      throw error;
    }
    throw new NotFoundError('A valid file path is required.');
  }

  if (!accessInfo || !resolved) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Access denied.');
  }

  return resolved.absolutePath;
}

/**
 * The editor's read. By GET, which the browser keeps and revalidates, so the
 * editor opened from the Markdown preview does not download the file again; by
 * POST for the clients written against it, which nothing keeps.
 */
const sendEditorText = async (req, res, relative) => {
  const absolutePath = await resolveReadableFile(req, relative);
  await sendTextFile(req, res, { absolutePath, render: ({ text }) => ({ content: text }) });
};

router.get(
  '/editor',
  asyncHandler(async (req, res) => {
    await sendEditorText(req, res, req.query?.path);
  })
);

router.post(
  '/editor',
  asyncHandler(async (req, res) => {
    const { path: relative = '' } = req.body || {};
    await sendEditorText(req, res, relative);
  })
);

router.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const absolutePath = await resolveReadableFile(req, req.query?.path);
    await sendTextFile(req, res, {
      absolutePath,
      headers: { 'X-Content-Type-Options': 'nosniff' },
      render: ({ text }) => text,
    });
  })
);

router.put(
  '/editor',
  asyncHandler(async (req, res) => {
    const { path: relative = '', content = '' } = req.body || {};
    if (typeof relative !== 'string' || !relative) {
      throw new ValidationError('A valid file path is required.');
    }
    // Answered rather than thrown at the write: `null` used to reach the file
    // itself, where it failed as a server error after the document had already
    // been opened for writing.
    if (typeof content !== 'string') {
      throw new ValidationError('The content to save must be text.');
    }

    const relativePath = normalizeRelativePath(relative);

    // Prevent creating files directly in the volume root
    // Check if the file would be created at the root level (no parent directory)
    if (!relativePath.includes('/') && !relativePath.includes(path.sep)) {
      throw new ValidationError(
        'Cannot create files in the root volume path. Please select a specific volume first.'
      );
    }

    const context = { user: req.user, guestSession: req.guestSession };
    let accessInfo;
    let resolved;
    try {
      const result = await authorizeAndResolve(context, relativePath, ACTIONS.write);
      if (!result.allowed || !result.resolved) {
        throw new ForbiddenError(result.accessInfo?.denialReason || 'This path is read-only.');
      }
      accessInfo = result.accessInfo;
      resolved = result.resolved;
    } catch (error) {
      if (error && error.isOperational) {
        throw error;
      }
      throw new NotFoundError('A valid file path is required.');
    }

    if (!accessInfo || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'This path is read-only.');
    }

    const { absolutePath } = resolved;

    await ensureDir(path.dirname(absolutePath));
    // What the file weighed before, for the index: a save replaces content, so the
    // folder it sits in gains the difference rather than the whole of the new file.
    const before = await fs.stat(absolutePath).catch(() => null);
    const existed = Boolean(before?.isFile());
    const previousSize = existed ? before.size : 0;

    // Written back in the encoding it already had: a UTF-16 file saved as UTF-8
    // reads perfectly well here and breaks whatever wrote it.
    const payload = encodeText(content, existed ? await readFileEncoding(absolutePath) : undefined);
    // Refused for the same reason the editor refuses to open it. Without this
    // the editor wrote whatever it was given — paste two megabytes into a small
    // file, save, and the next attempt to open it answered that the file is too
    // large. Measured on the bytes actually written, which is what the size
    // limit is about.
    if (payload.length > MAX_EDITOR_FILE_SIZE) {
      throw new ValidationError('This file is too large to save in the text editor.');
    }

    // Written beside the file and put in place once whole, with what it
    // replaces kept as a version: a save used to go straight over the file, so
    // a stop halfway through left it truncated and the state it replaced was
    // gone. Somebody pressed Save, so it is a state worth keeping — there is no
    // session here to group it with, as there is in the office editors.
    await versions.saveFile(
      absolutePath,
      (temporaryPath) => fs.writeFile(temporaryPath, payload, { flag: 'wx' }),
      {
        purpose: 'editor',
        author: versions.authorOf({ user: req.user, guestSession: req.guestSession }),
        source: 'editor',
        explicit: true,
      }
    );
    // The index takes the difference the save made, from the size it can already
    // see, instead of waiting for the periodic sweep to walk the folder again.
    const updated = await fs.stat(absolutePath).catch(() => null);
    if (updated) {
      if (existed) {
        await folderSizeHooks.onFileReplaced(absolutePath, previousSize, updated.size);
      } else {
        await folderSizeHooks.onFileWritten(absolutePath, updated.size);
      }
    }

    res.send({ success: true });
  })
);

module.exports = router;
