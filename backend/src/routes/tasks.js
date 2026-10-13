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
 * What is running, what has just finished, and what a restart took.
 *
 * The interrupted ones are not tasks: nothing is resumed across a stop, by
 * design — half a copy is a state on disk, and picking it up would mean deciding
 * about what is already there. They are a record of what was in flight when the
 * server went down, kept so the person who started it is told, with the paths,
 * rather than left to find out by looking.
 */
router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    res.json({
      items: operationTasks.listFor(owner, { shareId }),
      interrupted: operationTasks.interruptedFor(owner, shareId),
    });
  })
);

// Told, and no longer waiting to be. Without `ids`, all of them.
router.post(
  '/tasks/interrupted/ack',
  asyncHandler(async (req, res) => {
    const { owner, shareId } = asking(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json(operationTasks.forgetInterrupted(owner, shareId, ids));
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
