const express = require('express');

const { sanitizeClientMessage } = require('../middleware/errorHandler');
const asyncHandler = require('../utils/asyncHandler');
const { sendCompressible } = require('../utils/compressedResponse');
const { startNdjsonStream } = require('../utils/ndjsonStream');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const trash = require('../services/trash');
const activityLog = require('../services/activityLog');

const router = express.Router();

const contextOf = (req) => ({ user: req.user, guestSession: req.guestSession });

// GET /api/trash - what the signed-in person's trash holds
router.get(
  '/trash',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await trash.listItems(contextOf(req)));
  })
);

// POST /api/trash/restore - put items back where they were deleted from
router.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const outcome = await trash.restoreItems(req.body?.ids, contextOf(req), {
      shares: req.body?.shares,
    });
    // What came back, under the name it came back as: a restore that had to
    // take "name (1)" is exactly the line somebody will be looking for.
    const restored = (outcome.items || []).filter((item) => item.status === 'restored');
    await activityLog.record({
      action: 'file.restore',
      user: req.user,
      target: restored[0]?.restoredName || restored[0]?.name || null,
      detail: { items: restored.length },
      req,
    });
    res.json(outcome);
  })
);

// GET /api/trash/items/:id/entries?path= - what a deleted folder holds, at a path inside it
router.get(
  '/trash/items/:id/entries',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await trash.listEntries(req.params.id, req.query.path ?? '', contextOf(req)));
  })
);

// POST /api/trash/items/:id/restore - put back entries from inside a deleted folder
router.post(
  '/trash/items/:id/restore',
  asyncHandler(async (req, res) => {
    res.json(
      await trash.restoreEntries(req.params.id, req.body?.paths, contextOf(req), {
        shares: req.body?.shares,
      })
    );
  })
);

/**
 * GET /api/trash/items/:id/text?path= - the text of a file in the trash, to read
 * before deciding what to do with it: the item itself, or a file inside a
 * deleted folder. Read only — there is no route that writes into the trash —
 * with the editor's limits on size and binary content, and never cached.
 */
router.get(
  '/trash/items/:id/text',
  asyncHandler(async (req, res) => {
    const text = await trash.readTrashText(req.params.id, req.query.path ?? '', contextOf(req));
    res.set('Cache-Control', 'private, no-store');
    await sendCompressible(req, res, text);
  })
);

/**
 * Restore into a folder someone chose. Across disks that is a copy, which can
 * take a while, so it streams its progress the way a transfer does:
 *   {type:'start',    totalBytes, totalItems, destination}
 *   {type:'progress', copiedBytes, totalBytes, currentName, completedItems}
 *   {type:'done',     destination, items}
 *   {type:'error',    message, code}
 * Everything that can be refused is checked before the stream starts, so a
 * refusal is an ordinary HTTP error. Closing the request cancels the restore
 * in progress: its item stays in the trash.
 */
const restoreTo = (planFrom) =>
  asyncHandler(async (req, res) => {
    const plan = await trash.prepareRestoreTo(planFrom(req), contextOf(req));
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    const writeEvent = startNdjsonStream(res, { onClose });

    try {
      const result = await trash.executeRestoreTo(plan, {
        onEvent: writeEvent,
        signal: controller.signal,
      });
      writeEvent({ type: 'done', ...result });
    } catch (error) {
      writeEvent({
        type: 'error',
        message: sanitizeClientMessage(error.message || 'The restore failed.'),
        code: error.code || 'TRASH_RESTORE_FAILED',
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  });

// POST /api/trash/restore-to - put items back in a chosen folder, streamed
router.post(
  '/trash/restore-to',
  restoreTo((req) => ({
    ids: req.body?.ids,
    destination: req.body?.destination,
    shares: req.body?.shares,
  }))
);

// POST /api/trash/items/:id/restore-to - put entries of a deleted folder in a chosen folder, streamed
router.post(
  '/trash/items/:id/restore-to',
  restoreTo((req) => ({
    id: req.params.id,
    paths: req.body?.paths,
    destination: req.body?.destination,
    shares: req.body?.shares,
  }))
);

// POST /api/trash/delete - remove items for good
router.post(
  '/trash/delete',
  asyncHandler(async (req, res) => {
    const outcome = await trash.purgeItems(req.body?.ids, contextOf(req), {
      forgetUnavailable: req.body?.forgetUnavailable === true,
    });
    await activityLog.record({
      action: 'file.purge',
      user: req.user,
      detail: { items: Array.isArray(req.body?.ids) ? req.body.ids.length : 1 },
      req,
    });
    res.json(outcome);
  })
);

// POST /api/trash/empty - remove everything this person can see, for good
router.post(
  '/trash/empty',
  asyncHandler(async (req, res) => {
    const outcome = await trash.emptyTrash(contextOf(req));
    await activityLog.record({ action: 'file.purge', user: req.user, detail: { all: true }, req });
    res.json(outcome);
  })
);

// GET /api/trash/zones - every zone, what it holds and may hold (admin only)
router.get(
  '/trash/zones',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ zones: await trash.zonesOverview() });
  })
);

// POST /api/trash/verify - check every zone against its invariants (admin only)
router.post(
  '/trash/verify',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await trash.verifyAll());
  })
);

// POST /api/trash/maintenance - run the maintenance pass now (admin only)
router.post(
  '/trash/maintenance',
  ensureAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ zones: await trash.runMaintenance() });
  })
);

module.exports = router;
