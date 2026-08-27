const { sanitizeClientMessage } = require('../../middleware/errorHandler');
const { prepareTransfer, executeTransfer } = require('../../services/fileTransferService');
const recentDestinations = require('../../services/recentDestinationsService');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const fs = require('node:fs/promises');
const asyncHandler = require('../../utils/asyncHandler');
const { startNdjsonStream } = require('../../utils/ndjsonStream');

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

      streaming = true;
      writeEvent = startNdjsonStream(res, { onClose });

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

      // Recorded from the transfer itself rather than asked of the client, so
      // every route into a folder counts — the picker, a drag onto a favorite,
      // a paste — and the list reflects where things really go.
      await recentDestinations.record(req.user?.id, prep.destinationRelative);

      writeEvent({ type: 'done', success: true, ...result });
    } catch (error) {
      // Keep authorization/validation failures as ordinary HTTP errors. Once
      // streaming starts, the error belongs to the NDJSON operation stream.
      if (!streaming) throw error;
      writeEvent({
        type: 'error',
        message: sanitizeClientMessage(error.message || 'Transfer failed.'),
        code: error.code || 'TRANSFER_FAILED',
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      if (streaming && !res.writableEnded) res.end();
    }
  });

/**
 * Where this user has recently moved or copied things.
 *
 * Filtered against what they can reach right now: a folder can be deleted or
 * have its access revoked long after it was last used, and offering it as a
 * destination would only produce a failure at the end of the flow. Anything
 * gone is forgotten on the way out, so the list heals itself.
 */
router.get(
  '/files/recent-destinations',
  asyncHandler(async (req, res) => {
    const paths = await recentDestinations.list(req.user?.id);
    const context = { user: req.user, guestSession: req.guestSession };

    const reachable = [];
    for (const relativePath of paths) {
      // eslint-disable-next-line no-await-in-loop
      const { allowed, resolved } = await authorizeAndResolve(
        context,
        relativePath,
        ACTIONS.upload
      );
      // eslint-disable-next-line no-await-in-loop
      const stats = resolved ? await fs.stat(resolved.absolutePath).catch(() => null) : null;

      if (allowed && stats?.isDirectory()) {
        reachable.push(relativePath);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await recentDestinations.forget(req.user?.id, relativePath);
      }
    }

    res.json({ items: reachable });
  })
);

router.post('/files/copy', runTransfer('copy'));
router.post('/files/move', runTransfer('move'));

module.exports = router;
