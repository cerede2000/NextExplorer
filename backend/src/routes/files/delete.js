const { sanitizeClientMessage } = require('../../middleware/errorHandler');
const {
  deleteItems,
  getDeleteImpact,
  resolveDeleteTargets,
} = require('../../services/fileTransferService');
const activityLog = require('../../services/activityLog');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const { startNdjsonStream, throttleProgress } = require('../../utils/ndjsonStream');

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

/**
 * What a deletion writes down.
 *
 * Into the trash is one thing and off the disk is another, and the day
 * somebody comes looking, which of the two it was is the question. Both routes
 * record through here: the interface uses the streamed one, and a deletion
 * that only the plain one recorded would be a log with a hole exactly where
 * people look.
 */
const recordDeletion = ({ items, permanent, req }) =>
  activityLog.record({
    action: permanent === true ? 'file.purge' : 'file.delete',
    user: req.user,
    target: typeof items[0] === 'string' ? items[0] : items[0]?.path,
    detail: items.length > 1 ? { items: items.length } : null,
    req,
  });

router.delete(
  '/files',
  asyncHandler(async (req, res) => {
    const { items = [], permanent = false } = req.body || {};
    const results = await deleteItems(items, {
      user: req.user,
      guestSession: req.guestSession,
      permanent: permanent === true,
    });
    await recordDeletion({ items, permanent, req });
    res.json({ success: true, items: results });
  })
);

router.post(
  '/files/delete-stream',
  asyncHandler(async (req, res) => {
    const { items = [], permanent = false } = req.body || {};
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);

    // Authorize before switching to the stream: once the headers are out, a
    // refusal can only be reported as a 200 carrying an error event, which a
    // client that does not parse NDJSON reads as success. This matches how
    // the transfer and archive routes behave.
    const context = { user: req.user, guestSession: req.guestSession };
    // Timed so an installation can see where a slow bulk delete actually
    // spends its time, instead of guessing between the server and the browser.
    const startedAt = Date.now();
    const targets = await resolveDeleteTargets(items, context);
    const resolvedAt = Date.now();

    const writeEvent = startNdjsonStream(res, { onClose });

    try {
      writeEvent({
        type: 'start',
        phase: 'preparing',
        totalItems: Array.isArray(items) ? items.length : 0,
      });
      const reportProgress = throttleProgress((event) => writeEvent(event));
      const results = await deleteItems(items, {
        targets,
        user: req.user,
        guestSession: req.guestSession,
        permanent: permanent === true,
        signal: controller.signal,
        onProgress: (progress) => reportProgress({ type: 'progress', ...progress }),
      });
      reportProgress.flush();
      const finishedAt = Date.now();
      logger.info(
        {
          items: targets.length,
          resolveMs: resolvedAt - startedAt,
          deleteMs: finishedAt - resolvedAt,
          totalMs: finishedAt - startedAt,
        },
        'Bulk delete completed'
      );
      await recordDeletion({ items, permanent, req });
      writeEvent({ type: 'done', success: true, items: results });
    } catch (error) {
      writeEvent({
        type: 'error',
        message: sanitizeClientMessage(error.message || 'Deletion failed.'),
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
