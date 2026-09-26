const express = require('express');

const { buildOpenApi, appVersion } = require('../openapi');

const router = express.Router();

/**
 * The description of this instance's API, for a generated client or an
 * explorer pointed at it.
 *
 * Answered to anybody, as `/api/features` is: it says nothing about this
 * installation that the published documentation does not, and a tool asking
 * for it should not need a session first. Built once — it is the same for
 * the life of the process.
 */
let document = null;

router.get('/openapi.json', (_req, res) => {
  if (!document) document = buildOpenApi({ version: appVersion() || undefined });
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(document);
});

module.exports = router;
