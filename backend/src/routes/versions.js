const express = require('express');
const fs = require('fs');

const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { mimeTypes } = require('../config/index');
const versions = require('../services/versions');
const { encodeContentDisposition } = require('./files/utils');

/**
 * A file's history, through the API.
 *
 * Every route names the file it is about by its path, as the rest of the API
 * does, and the version by its id: a version is only ever reached through the
 * file it belongs to, with that file's rights.
 */
const router = express.Router();

const contextOf = (req) => ({ user: req.user, guestSession: req.guestSession });

const mimeTypeOf = (name = '') =>
  mimeTypes[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

router.get(
  '/versions',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await versions.listVersions(contextOf(req), req.query?.path));
  })
);

router.get(
  '/versions/:id/content',
  asyncHandler(async (req, res) => {
    const located = await versions.downloadVersion(contextOf(req), req.query?.path, req.params.id);
    res.writeHead(200, {
      'Content-Type': mimeTypeOf(located.name),
      'Content-Length': located.size,
      'Content-Disposition': encodeContentDisposition(located.downloadName, 'attachment'),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(located.absolutePath);
    stream.on('error', (error) => {
      logger.warn({ err: error, versionId: req.params.id }, 'A version could not be streamed');
      res.destroy(error);
    });
    stream.pipe(res);
  })
);

router.post(
  '/versions/:id/restore',
  asyncHandler(async (req, res) => {
    res.json(await versions.restoreVersion(contextOf(req), req.body?.path, req.params.id));
  })
);

router.post(
  '/versions/:id/copy',
  asyncHandler(async (req, res) => {
    res.json(
      await versions.copyVersionTo(contextOf(req), req.body?.path, req.params.id, {
        destination: req.body?.destination,
        name: req.body?.name,
      })
    );
  })
);

router.post(
  '/versions/:id/replace',
  asyncHandler(async (req, res) => {
    res.json(
      await versions.replaceWithVersion(contextOf(req), req.body?.path, req.params.id, {
        target: req.body?.target,
      })
    );
  })
);

router.patch(
  '/versions/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await versions.updateVersion(contextOf(req), req.body?.path, req.params.id, {
        label: req.body?.label,
        pinned: req.body?.pinned,
      })
    );
  })
);

router.post(
  '/versions/delete',
  asyncHandler(async (req, res) => {
    const outcome = await versions.deleteVersions(contextOf(req), req.body?.path, {
      ids: req.body?.ids,
      all: req.body?.all === true,
    });

    res.json(outcome);
  })
);

module.exports = router;
