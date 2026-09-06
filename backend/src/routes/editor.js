const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const folderSizeHooks = require('../services/folderSizeHooks');
const {
  readTextFile,
  readFileEncoding,
  encodeText,
  MAX_EDITOR_FILE_SIZE,
} = require('../services/textEditorService');

const router = express.Router();

async function readTextFileBuffer(req, relative) {
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

  const { absolutePath } = resolved;
  const textFile = await readTextFile(absolutePath);
  return { ...textFile, absolutePath };
}

router.post(
  '/editor',
  asyncHandler(async (req, res) => {
    const { path: relative = '' } = req.body || {};
    const { text } = await readTextFileBuffer(req, relative);
    res.send({ content: text });
  })
);

router.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const relative = req.query?.path;
    const { text } = await readTextFileBuffer(req, relative);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(text);
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
    await fs.writeFile(absolutePath, payload);
    const updated = await fs.stat(absolutePath);
    if (existed) {
      await folderSizeHooks.onFileReplaced(absolutePath, previousSize, updated.size);
    } else {
      await folderSizeHooks.onFileWritten(absolutePath, updated.size);
    }
    res.send({ success: true });
  })
);

module.exports = router;
