const path = require('path');
const fs = require('fs/promises');

const { normalizeRelativePath, ensureValidName, splitName } = require('../../utils/pathUtils');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const asyncHandler = require('../../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const { buildItemMetadata } = require('./utils');

const router = require('express').Router();

const createUniqueEmptyFile = async (parentAbsolute, requestedName) => {
  const { base, extension } = splitName(requestedName);

  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const finalName = attempt === 1 ? requestedName : `${base} ${attempt}${extension}`;
    const absolutePath = path.join(parentAbsolute, finalName);

    try {
      const handle = await fs.open(absolutePath, 'wx');
      await handle.close();
      return { absolutePath, finalName };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }

  throw new ValidationError('Unable to allocate a unique file name.');
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
    const { absolutePath, finalName } = await createUniqueEmptyFile(
      resolved.absolutePath,
      baseName
    );
    const item = await buildItemMetadata(absolutePath, parentRelative, finalName);

    res.status(201).json({ success: true, item });
  })
);

module.exports = router;
