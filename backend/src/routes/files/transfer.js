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
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    const options = { user: req.user, guestSession: req.guestSession, signal: controller.signal };
    let streaming = false;
    let writeEvent = () => {};

    try {
      const prep = await prepareTransfer(items, destination, operation, options);

      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      // Disable proxy buffering so progress lines reach the client promptly.
      res.setHeader('X-Accel-Buffering', 'no');
      streaming = true;
      res.once('close', onClose);

      writeEvent = (event) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`${JSON.stringify(event)}\n`);
      };

      writeEvent({
        type: 'start',
        totalBytes: prep.totalBytes,
        totalItems: prep.totalItems,
        destination: prep.destinationRelative,
      });

      const result = await executeTransfer(
        prep,
        operation,
        (progress) => writeEvent({ type: 'progress', ...progress }),
        { signal: controller.signal }
      );
      writeEvent({ type: 'done', success: true, ...result });
    } catch (error) {
      // Keep authorization/validation failures as ordinary HTTP errors. Once
      // streaming starts, the error belongs to the NDJSON operation stream.
      if (!streaming) throw error;
      writeEvent({
        type: 'error',
        message: error.message || 'Transfer failed.',
        code: error.code || 'TRANSFER_FAILED',
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      if (streaming && !res.writableEnded) res.end();
    }
  });

router.post('/files/copy', runTransfer('copy'));
router.post('/files/move', runTransfer('move'));

module.exports = router;
