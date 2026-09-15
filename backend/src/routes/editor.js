const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const asyncHandler = require('../utils/asyncHandler');
const { sendTextFile } = require('../utils/textFileResponse');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const folderSizeHooks = require('../services/folderSizeHooks');
const versions = require('../services/versions/operations');
const {
  readFileEncoding,
  encodeText,
  textFileEtag,
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
    if (typeof content !== 'string') {
      throw new ValidationError('Text editor content must be a string.');
    }
    // Refused for the same reason the editor refuses to open it. Without this
    // the editor wrote whatever it was given — paste two megabytes into a small
    // file, save, and the next attempt to open it answered that the file is too
    // large. The shared-editor route has always checked; this one did not.
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
    let previousSize = 0;
    let existed = false;
    try {
      const previous = await fs.stat(absolutePath);
      existed = previous.isFile();
      previousSize = existed ? previous.size : 0;
    } catch {
      // A new file is the expected path.
    }

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
    // Written beside the file and renamed over it: writing in place left a
    // truncated file behind a crash in the middle of a save. What it replaces
    // is kept as a version.
    let written = null;
    await versions.saveFile(
      absolutePath,
      async (temporaryPath) => {
        await fs.writeFile(temporaryPath, payload, { flag: 'wx' });
        written = await fs.stat(temporaryPath, { bigint: true });
      },
      { author: versions.authorOf(context), source: 'editor' }
    );
    const updated = await fs.stat(absolutePath, { bigint: true });
    if (existed) {
      await folderSizeHooks.onFileReplaced(absolutePath, previousSize, Number(updated.size));
    } else {
      await folderSizeHooks.onFileWritten(absolutePath, Number(updated.size));
    }
    // The identity the next read of the file will carry — given only when the
    // file now at the path is the one this save wrote. A save set aside, or one
    // whose content was already there, leaves another file in place; a write in
    // place right after the rename changes the modification time. Either way
    // this answer would name content it did not send.
    if (
      written &&
      updated.ino === written.ino &&
      updated.size === written.size &&
      updated.mtimeNs === written.mtimeNs
    ) {
      res.setHeader('ETag', textFileEtag(updated));
    }
    res.send({ success: true });
  })
);

module.exports = router;
