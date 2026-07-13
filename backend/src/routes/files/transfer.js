const { prepareTransfer, executeTransfer } = require('../../services/fileTransferService');
const asyncHandler = require('../../utils/asyncHandler');

const router = require('express').Router();

// Copy/move stream newline-delimited JSON events so the client can render a
// determinate progress bar:
//   {type:'start',    totalBytes, totalItems, destination}
//   {type:'progress', copiedBytes, totalBytes, currentName}   (throttled)
//   {type:'done',     success, destination, items}
//   {type:'error',    message, code}
// Validation/authorization runs first (prepareTransfer); if it throws, no
// streaming header has been sent yet, so asyncHandler forwards it to the error
// middleware and the client gets a normal HTTP error response.
const runTransfer = (operation) =>
  asyncHandler(async (req, res) => {
    const { items = [], destination = '' } = req.body || {};
    const options = { user: req.user, guestSession: req.guestSession };

    const prep = await prepareTransfer(items, destination, operation, options);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Disable proxy buffering so progress lines reach the client promptly.
    res.setHeader('X-Accel-Buffering', 'no');

    const writeEvent = (event) => {
      if (res.writableEnded) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    writeEvent({
      type: 'start',
      totalBytes: prep.totalBytes,
      totalItems: prep.totalItems,
      destination: prep.destinationRelative,
    });

    try {
      const result = await executeTransfer(prep, operation, (progress) =>
        writeEvent({ type: 'progress', ...progress })
      );
      writeEvent({ type: 'done', success: true, ...result });
    } catch (error) {
      writeEvent({
        type: 'error',
        message: error.message || 'Transfer failed.',
        code: error.code || 'TRANSFER_FAILED',
      });
    } finally {
      res.end();
    }
  });

router.post('/files/copy', runTransfer('copy'));
router.post('/files/move', runTransfer('move'));

module.exports = router;
