const { sanitizeClientMessage } = require('../../middleware/errorHandler');
const {
  deleteItems,
  getDeleteImpact,
  resolveDeleteTargets,
} = require('../../services/fileTransferService');
const activityLog = require('../../services/activityLog');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const { throttleProgress } = require('../../utils/ndjsonStream');
const operationTasks = require('../../services/operationTasks');
const { streamTask } = require('../../utils/taskStream');
const { ConflictError, NotFoundError, UnauthorizedError } = require('../../errors/AppError');

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
 *
 * Read from what each deletion did, and not from the `permanent` flag the
 * request carried. That flag is what the caller asked for, which is not what
 * happened: with the trash switched off, the interface asks for nothing in
 * particular — there is no trash to choose — and every file it deleted for
 * good was written down as having been moved to the trash that does not
 * exist. The service already answers per item, `trashed` or `deleted`, and
 * that is the only account of it that cannot be wrong.
 *
 * One line per outcome, so a selection that was partly kept and partly
 * removed says both rather than the first one twice. An item that did not go
 * anywhere — already missing, or refused by the trash and left where it is —
 * writes nothing at all, where it used to be counted among the deleted.
 */
const ACTION_FOR = { trashed: 'file.delete', deleted: 'file.purge' };

const recordDeletion = async ({ results, req }) => {
  const byAction = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const action = ACTION_FOR[result?.status];
    if (!action) continue;
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(result.path);
  }

  for (const [action, paths] of byAction) {
    await activityLog.record({
      action,
      user: req.user,
      target: paths[0] || null,
      detail: paths.length > 1 ? { items: paths.length } : null,
      req,
    });
  }

  // The part of a deletion that nothing on screen showed. A file is one line
  // in a folder and its earlier versions are none, so a deletion that took
  // ten of them said as much as one that took none — and versions are the
  // half that cannot be restored from anywhere.
  const withHistory = (Array.isArray(results) ? results : []).filter(
    (result) => Number(result?.versionsPurged) > 0
  );
  if (withHistory.length === 0) return;
  const versions = withHistory.reduce((total, result) => total + result.versionsPurged, 0);
  const bytes = withHistory.reduce(
    (total, result) => total + (Number(result.versionBytesPurged) || 0),
    0
  );
  await activityLog.record({
    action: 'versions.purge',
    user: req.user,
    target: withHistory[0].path,
    detail: {
      versions,
      bytes,
      ...(withHistory.length > 1 ? { files: withHistory.length } : {}),
      with: 'file',
    },
    req,
  });
};

router.delete(
  '/files',
  asyncHandler(async (req, res) => {
    const { items = [], permanent = false } = req.body || {};
    const results = await deleteItems(items, {
      user: req.user,
      guestSession: req.guestSession,
      permanent: permanent === true,
    });
    await recordDeletion({ results, req });
    res.json({ success: true, items: results });
  })
);

/** A new deletion task, with the answer it will build. */
const openDeletionTask = ({ owner, shareId }) => {
  const bag = { items: [] };
  return operationTasks.open({
    kind: 'delete',
    owner,
    shareId,
    bag,
    collect: () => ({ items: bag.items }),
  });
};

/**
 * A deletion that belongs to the person who asked, not to the tab.
 *
 * It ran inside its own request: closing the tab closed the socket, the socket
 * aborted the deletion, and a selection of a hundred thousand entries was half
 * gone with nothing said about which half. It is registered now — see
 * `services/operationTasks` — and this response is a window onto it: closing the
 * window detaches a watcher, and `POST /api/tasks/<id>/cancel` is how one is
 * stopped.
 *
 * The same stream as before, with `taskId` added to the `start` event. A
 * selection too large for one request body still arrives as several, and they
 * all name the same operation now rather than being one operation each: the
 * first opens it and says more is coming, the rest are added to it and answered
 * at once. A reader who closed the tab a moment in used to lose every batch that
 * had not been sent yet.
 */
router.post(
  '/files/delete-stream',
  asyncHandler(async (req, res) => {
    const { items = [], permanent = false, taskId = null, continues = false } = req.body || {};
    const owner = operationTasks.ownerOf(req);
    if (!owner) throw new UnauthorizedError('Authentication required.');
    const shareId = req.shareScope?.shareId ?? null;
    const context = { user: req.user, guestSession: req.guestSession };

    // The operation this part belongs to, before its items are looked at: an id
    // that names nothing of this caller's is refused whatever it carries, and
    // answers exactly as one that names nothing at all.
    const running = taskId
      ? operationTasks.reopen(taskId, owner, { shareId, kind: 'delete' })
      : null;
    if (taskId && !running) throw new NotFoundError('No such operation.');

    // Authorize before switching to the stream: once the headers are out, a
    // refusal can only be reported as a 200 carrying an error event, which a
    // client that does not parse NDJSON reads as success. This matches how the
    // transfer and archive routes behave.
    //
    // Timed so an installation can see where a slow bulk delete actually spends
    // its time, instead of guessing between the server and the browser.
    const startedAt = Date.now();
    let targets;
    try {
      targets = await resolveDeleteTargets(items, context);
    } catch (error) {
      // A part that is refused is the end of the selection: the operation
      // finishes on what it has rather than waiting for the rest.
      running?.seal();
      throw error;
    }
    const resolvedAt = Date.now();

    const handle = running || openDeletionTask({ owner, shareId });
    // Entries rather than bytes: a deletion has no byte count to measure, so
    // how many of them are gone is what the bar is drawn from.
    handle.grow({ totalItems: targets.length, bytesKnown: false });

    const queued = handle.enqueue(
      async () => {
        const reportProgress = throttleProgress((event) =>
          handle.report({ unitItems: event.completedItems, currentName: event.currentName })
        );
        const results = await deleteItems(items, {
          targets,
          user: req.user,
          guestSession: req.guestSession,
          permanent: permanent === true,
          signal: handle.signal,
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
        await recordDeletion({ results, req });
        handle.bag.items.push(...results);
        handle.advance({ items: targets.length });
      },
      (error) => ({
        message: sanitizeClientMessage(error.message || 'Deletion failed.'),
        code: error.code || 'DELETE_FAILED',
      })
    );
    if (!queued) throw new ConflictError('That operation has already finished.');

    if (!continues) handle.seal();

    // One window is enough: the request that opened the operation carries it,
    // and the rest of a large selection is answered as soon as it is queued.
    if (taskId) {
      res.status(202).json({ taskId: handle.id, accepted: targets.length });
      return;
    }

    streamTask(res, handle.id, owner, shareId);
  })
);

module.exports = router;
