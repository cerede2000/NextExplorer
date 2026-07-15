const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { ensureDir } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const { readTextFile } = require('../services/textEditorService');

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
    const { buffer } = await readTextFileBuffer(req, relative);
    const data = buffer.toString('utf-8');
    res.send({ content: data });
  })
);

router.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const relative = req.query?.path;
    const { buffer } = await readTextFileBuffer(req, relative);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer.toString('utf-8'));
  })
);

router.put(
  '/editor',
  asyncHandler(async (req, res) => {
    const { path: relative = '', content = '' } = req.body || {};
    if (typeof relative !== 'string' || !relative) {
      throw new ValidationError('A valid file path is required.');
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
    await fs.writeFile(absolutePath, content, { encoding: 'utf-8' });
    res.send({ success: true });
  })
);

module.exports = router;
