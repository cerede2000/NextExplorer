const { normalizeRelativePath } = require('../../utils/pathUtils');
const asyncHandler = require('../../utils/asyncHandler');
const { buildItemMetadata } = require('./utils');
const { renameEntry } = require('../../services/renameService');

const router = require('express').Router();

router.post(
  '/files/rename',
  asyncHandler(async (req, res) => {
    const parentRelative = normalizeRelativePath(req.body?.path ?? '');
    const context = { user: req.user, guestSession: req.guestSession };

    const renamed = await renameEntry({
      context,
      parentRelative,
      currentName: req.body?.name,
      newName: req.body?.newName,
    });

    const item = await buildItemMetadata(renamed.absolutePath, parentRelative, renamed.name);
    res.json({ success: true, item });
  })
);

module.exports = router;
