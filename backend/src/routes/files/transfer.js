const { sanitizeClientMessage } = require('../../middleware/errorHandler');
const { prepareTransfer, executeTransfer } = require('../../services/fileTransferService');
const recentDestinations = require('../../services/recentDestinationsService');
const operationTasks = require('../../services/operationTasks');
const { ACTIONS, authorizeAndResolve } = require('../../services/authorizationService');
const fs = require('node:fs/promises');
const asyncHandler = require('../../utils/asyncHandler');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { streamTask } = require('../../utils/taskStream');
const { ConflictError, NotFoundError, UnauthorizedError } = require('../../errors/AppError');

const router = require('express').Router();

/**
 * A new transfer task, with the answer it will build and what to do once it is
 * built.
 *
 * Where things were put is recorded from the transfer itself rather than asked
 * of the client, so every route into a folder counts — the picker, a drag onto
 * a favorite, a paste — and the list reflects where things really go. Only once
 * the whole task succeeded, and only for an account: a visitor has no list.
 */
const openTransferTask = ({ operation, owner, shareId, prep, req }) => {
  const bag = { destination: prep.destinationRelative, items: [], unreadable: 0 };
  const handle = operationTasks.open({
    kind: operation,
    owner,
    shareId,
    destination: prep.destinationRelative,
    bag,
    collect: () => ({
      destination: bag.destination,
      items: bag.items,
      ...(bag.unreadable > 0 ? { unreadable: bag.unreadable } : {}),
    }),
  });

  const userId = req.user?.id;
  if (userId) {
    handle.settled.then((view) => {
      if (view.state !== 'done') return;
      recentDestinations.record(userId, prep.destinationRelative).catch(() => {});
    });
  }

  return handle;
};

// Copy/move stream newline-delimited JSON events so the client can render a
// determinate progress bar:
//   {type:'start',    taskId, totalBytes, totalItems, destination}
//   {type:'progress', copiedBytes, totalBytes, completedItems, currentName}
//   {type:'done',     success, destination, items}
//   {type:'error',    message, code}
//
// The work itself is not in this handler any more. It is registered as a task
// (services/operationTasks) and the response is a window onto it: a transfer
// used to be aborted by its own socket closing, so closing the tab left half a
// folder at the destination and said nothing. `taskId` in the `start` event is
// what a tab opened later uses to watch the same operation again, and
// `POST /api/tasks/<id>/cancel` is now the way to stop one.
//
// Validation and authorization still run first, before any work is queued: if
// they throw, nothing has been written to the response and the client gets an
// ordinary HTTP error.
//
// A selection too large for one request body arrives as several, all naming the
// same task through `taskId`, and `continues: true` says another one is coming.
// Only the first request streams; the rest are answered at once, because one
// window onto the task is enough. A task that is never told it is complete
// closes itself on what it received (SEAL_WITHIN_MS).
const runTransfer = (operation) =>
  asyncHandler(async (req, res) => {
    const { items = [], destination = '', taskId = null, continues = false } = req.body || {};
    const owner = operationTasks.ownerOf(req);
    if (!owner) throw new UnauthorizedError('Authentication required.');
    const shareId = req.shareScope?.shareId ?? null;

    // The operation this part belongs to, found before its items are checked:
    // an id that names nothing of this caller's is refused whatever it carries.
    // The same answer as one that names nothing at all, so this cannot be asked
    // which ids exist.
    const running = taskId
      ? operationTasks.reopen(taskId, owner, {
          shareId,
          kind: operation,
          destination: normalizeRelativePath(destination),
        })
      : null;
    if (taskId && !running) throw new NotFoundError('No such operation.');

    let prep;
    try {
      prep = await prepareTransfer(items, destination, operation, {
        user: req.user,
        guestSession: req.guestSession,
      });
    } catch (error) {
      // A part that is refused is the end of the selection: the operation
      // finishes on what it has rather than waiting for the rest of a selection
      // the caller has just been told it cannot send.
      running?.seal();
      throw error;
    }

    const handle = running || openTransferTask({ operation, owner, shareId, prep, req });

    handle.grow({
      totalItems: prep.totalItems,
      totalBytes: prep.totalBytes,
      bytesKnown: prep.totalBytes > 0 || prep.totalItems === 0,
      names: prep.plans.filter((plan) => !plan.skipped).map((plan) => plan.sourceRelative),
    });

    const queued = handle.enqueue(
      async () => {
        const result = await executeTransfer(
          prep,
          operation,
          ({ copiedBytes, currentName, percent }) =>
            handle.report({ unitBytes: copiedBytes, currentName, percent }),
          { signal: handle.signal }
        );
        handle.bag.items.push(...(Array.isArray(result.items) ? result.items : []));
        handle.bag.unreadable += Number(result.unreadable) || 0;
        handle.bag.destination = result.destination ?? handle.bag.destination;
        handle.advance({ items: prep.totalItems, bytes: Math.max(0, prep.totalBytes) });
      },
      (error) => ({
        message: sanitizeClientMessage(error?.message || 'Transfer failed.'),
        code: error?.code || 'TRANSFER_FAILED',
      })
    );

    // An operation that ended while this part was being checked: checking can
    // take a while on slow storage, and an operation waiting for the rest of a
    // selection does not wait forever. Said rather than swallowed — answering
    // 202 to items nothing will carry is how a selection goes missing quietly.
    if (!queued) throw new ConflictError('That operation has already finished.');

    if (!continues) handle.seal();

    // One window is enough: the request that opened the task carries it, and the
    // rest of a large selection is answered as soon as it has been queued.
    if (taskId) {
      res.status(202).json({ taskId: handle.id, accepted: prep.totalItems });
      return;
    }

    streamTask(res, handle.id, owner, shareId);
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
      const { allowed, resolved } = await authorizeAndResolve(
        context,
        relativePath,
        ACTIONS.upload
      );
      const stats = resolved ? await fs.stat(resolved.absolutePath).catch(() => null) : null;

      if (allowed && stats?.isDirectory()) {
        reachable.push(relativePath);
      } else {
        await recentDestinations.forget(req.user?.id, relativePath);
      }
    }

    res.json({ items: reachable });
  })
);

router.post('/files/copy', runTransfer('copy'));
router.post('/files/move', runTransfer('move'));

module.exports = router;
