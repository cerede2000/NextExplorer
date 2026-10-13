const asyncHandler = require('../utils/asyncHandler');
const operationTasks = require('../services/operationTasks');
const { streamTask } = require('../utils/taskStream');
const { NotFoundError, UnauthorizedError } = require('../errors/AppError');

const router = require('express').Router();

/**
 * The operations of whoever is asking, which no longer belong to a tab.
 *
 * A copy or a move runs in the server now (see `services/operationTasks`), so a
 * tab is a window onto it: these three addresses are how a window is opened,
 * closed and reopened. Everything here answers for the caller's own tasks only,
 * and says nothing about anybody else's — an unknown operation and one that is
 * not yours are the same answer, so this cannot be asked whether an id exists.
 *
 * Under a share's prefix they answer for that share, and only for it: a
 * visitor's session is issued for one share, and what they started inside it is
 * not theirs to see from another.
 */
const asking = (req) => {
  const owner = operationTasks.ownerOf(req);
  if (!owner) throw new UnauthorizedError('Authentication required.');
  return { owner, shareId: req.shareScope?.shareId ?? null };
};

/**
 * What is running, and the news nobody has given this caller yet.
 *
 * Two kinds of news, and neither is a task. `interrupted` is what was in flight
 * when the server stopped: nothing is resumed across a stop, by design — half a
 * copy is a state on disk, and picking it up would mean deciding about what is
 * already there — so what it was carrying is written down instead, with the
 * paths. `unreported` is the other half of taking the work out of the request:
 * an operation that outlives its tab also *ends* out of sight, and an end nobody
 * saw is an end nobody was told about.
 *
 * Handed over once. `POST /api/tasks/told` is how a caller says it has been.
 */
router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    res.json({
      items: operationTasks.listFor(owner, { shareId }),
      ...operationTasks.untoldFor(owner, shareId),
    });
  })
);

// Told, and no longer waiting to be. Without `ids`, everything of this caller's.
router.post(
  '/tasks/told',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json(operationTasks.forgetUntold(owner, shareId, ids));
  })
);

router.get(
  '/tasks/:id/stream',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    streamTask(res, req.params.id, owner, shareId);
  })
);

router.post(
  '/tasks/:id/cancel',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    if (!operationTasks.cancel(req.params.id, owner, { shareId })) {
      throw new NotFoundError('No such operation.');
    }
    res.json({ cancelled: true });
  })
);

module.exports = router;
