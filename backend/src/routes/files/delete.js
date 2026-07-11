const { deleteItems, getDeleteImpact } = require('../../services/fileTransferService');
const asyncHandler = require('../../utils/asyncHandler');

const router = require('express').Router();

router.post(
  '/files/delete-impact',
  asyncHandler(async (req, res) => {
    const { items = [] } = req.body || {};
    const impact = await getDeleteImpact(items, {
      user: req.user,
      guestSession: req.guestSession,
    });
    res.json(impact);
  })
);

router.delete(
  '/files',
  asyncHandler(async (req, res) => {
    const { items = [] } = req.body || {};
    const results = await deleteItems(items, {
      user: req.user,
      guestSession: req.guestSession,
    });
    res.json({ success: true, items: results });
  })
);

module.exports = router;
