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

router.post(
  '/files/delete-stream',
  asyncHandler(async (req, res) => {
    const { items = [] } = req.body || {};
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.once('close', onClose);
    // Send the stream headers and initial event before the full preflight
    // validation. Deleting a large selection can legitimately take a moment
    // to authorize, but the UI must acknowledge the action immediately.
    res.flushHeaders?.();
    const writeEvent = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      writeEvent({
        type: 'start',
        phase: 'preparing',
        totalItems: Array.isArray(items) ? items.length : 0,
      });
      const results = await deleteItems(items, {
        user: req.user,
        guestSession: req.guestSession,
        signal: controller.signal,
        onProgress: (progress) => writeEvent({ type: 'progress', ...progress }),
      });
      writeEvent({ type: 'done', success: true, items: results });
    } catch (error) {
      writeEvent({
        type: 'error',
        message: error.message || 'Deletion failed.',
        code: error.code || 'DELETE_FAILED',
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  })
);

module.exports = router;
