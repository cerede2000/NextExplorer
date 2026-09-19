const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ensureAdmin } = require('../middleware/ensureAdmin');
const activityLog = require('../services/activityLog');
const versions = require('../services/versions');

/**
 * Every file that has a history, for an administrator.
 *
 * Apart from the routes beside it, and deliberately. Those answer about one
 * file, named by its path, with that file's own rights — the right shape for
 * somebody looking at a document they have open. These answer "where has the
 * space gone", which has no one path to ask about: a history whose file was
 * deleted outside the application has no file left to authorise against, and
 * it is exactly the kind nobody goes looking for.
 *
 * So a history is named here by its own id, and every route is behind
 * `ensureAdmin` — which also refuses an API token, whoever it belongs to.
 *
 * Under `/versions/admin/` rather than `/versions/files`: `/versions/:id/…`
 * already exists, and a first segment that could also be an id is how a route
 * ends up meaning two things.
 */
const router = express.Router();

/** A page of the files that have versions, narrowed and ordered as asked. */
router.get(
  '/versions/admin/files',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { zone, state, q, sort, limit, offset } = req.query || {};
    res.json(
      await versions.listFilesWithVersions({
        zoneId: typeof zone === 'string' ? zone : null,
        state: typeof state === 'string' ? state : null,
        query: typeof q === 'string' ? q : '',
        sort: typeof sort === 'string' && sort ? sort : 'bytes',
        limit,
        offset,
      })
    );
  })
);

/** One history and its versions, so they can be looked at before being deleted. */
router.get(
  '/versions/admin/files/:id',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(await versions.readFileVersions(req.params.id));
  })
);

/**
 * Delete versions of one history: the ones named, or all of them.
 *
 * A POST with a body rather than a DELETE with a list, as the route beside it
 * does, so that deleting forty versions is one request and one answer per
 * version — a DELETE per id would report forty times and fail in the middle.
 */
router.post(
  '/versions/admin/files/:id/delete',
  ensureAdmin,
  asyncHandler(async (req, res) => {
    // Read before, because a history deleted whole has no path afterwards to
    // say what was deleted.
    const before = await versions.readFileVersions(req.params.id);
    const outcome = await versions.deleteFileVersions(req.params.id, {
      ids: req.body?.ids,
      all: req.body?.all === true,
    });

    // The one route here that destroys something, and the data it destroys
    // may belong to somebody else — which is the case the log exists for. It
    // is off by default and never fails a request.
    await activityLog.record({
      action: 'file.purge',
      user: req.user,
      target: before.file.path || `${before.file.zone?.name || '?'}/${before.file.relativePath}`,
      detail: { versions: outcome.deleted, remaining: outcome.remaining, from: 'admin' },
      req,
    });

    res.json(outcome);
  })
);

module.exports = router;
