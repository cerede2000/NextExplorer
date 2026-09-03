const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { parseByteRange } = require('../../utils/httpRange');
const { resolvePathWithAccess } = require('../../services/accessManager');
const { extensions, mimeTypes } = require('../../config/index');
const { getRawPreviewJpegPath } = require('../../services/rawPreviewService');
const asyncHandler = require('../../utils/asyncHandler');
const {
  ValidationError,
  ForbiddenError,
  UnsupportedMediaTypeError,
} = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { markLongPoll } = require('../../middleware/heldRequests');

const router = require('express').Router();

// Formats the browser executes when opened as a top-level document. Served
// inline they would run their own scripts on the application origin, so they
// get a sandbox CSP — which still lets an <img> render them normally.
const ACTIVE_CONTENT_EXTENSIONS = new Set(['svg']);

const buildPreviewSecurityHeaders = (extension) => {
  const headers = {
    // Never let the browser second-guess the declared type.
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  };
  if (ACTIVE_CONTENT_EXTENSIONS.has(extension)) {
    headers['Content-Security-Policy'] = 'sandbox';
  }
  return headers;
};

router.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const { path: relative = '' } = req.query || {};
    if (typeof relative !== 'string' || !relative) {
      throw new ValidationError('A file path is required.');
    }

    const relativePath = normalizeRelativePath(relative);
    const context = { user: req.user, guestSession: req.guestSession };
    const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Preview not allowed.');
    }

    const { absolutePath } = resolved;
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      throw new ValidationError('Cannot preview a directory.');
    }

    const extension = path.extname(absolutePath).slice(1).toLowerCase();

    if ((extensions.rawImages || []).includes(extension)) {
      let jpegPath;
      try {
        jpegPath = await getRawPreviewJpegPath(absolutePath);
      } catch (error) {
        logger.warn({ absolutePath, err: error }, 'Failed to extract embedded RAW preview');
        throw new UnsupportedMediaTypeError('Preview is not available for this RAW file.');
      }

      const jpegStats = await fs.stat(jpegPath);

      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': jpegStats.size,
        ...buildPreviewSecurityHeaders('jpeg'),
      });

      const stream = fss.createReadStream(jpegPath);
      stream.on('error', (streamError) => {
        logger.error({ err: streamError }, 'RAW preview stream failed');
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy(streamError);
        }
      });
      stream.pipe(res);
      return;
    }

    if (!extensions.previewable.has(extension)) {
      throw new UnsupportedMediaTypeError('Preview is not available for this file type.');
    }

    const mimeType = mimeTypes[extension] || 'application/octet-stream';
    const securityHeaders = buildPreviewSecurityHeaders(extension);
    const isSeekableMedia =
      extensions.videos.includes(extension) || (extensions.audios || []).includes(extension);

    const streamFile = (options = undefined) => {
      const stream = options
        ? fss.createReadStream(absolutePath, options)
        : fss.createReadStream(absolutePath);
      stream.on('error', (streamError) => {
        logger.error({ err: streamError }, 'Preview stream failed');
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy(streamError);
        }
      });
      stream.pipe(res);
    };

    if (isSeekableMedia) {
      // Streaming a film holds the connection open for as long as the browser
      // wants it — minutes, and longer over a slow link. That is the request
      // doing its job, not a symptom, and the held-request instrument reports
      // only ten before falling silent for the life of the process: a handful
      // of videos would spend the whole budget and switch off the one tool
      // there is for finding a genuinely stuck server.
      markLongPoll(req);

      const range = parseByteRange(req.headers.range, stats.size);
      if (range?.malformed) {
        res.status(416).send('Malformed Range header');
        return;
      }
      if (range?.unsatisfiable) {
        res.status(416).send('Range Not Satisfiable');
        return;
      }
      if (range) {
        res.writeHead(206, {
          'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': range.chunkSize,
          'Content-Type': mimeType,
          ...securityHeaders,
        });
        streamFile({ start: range.start, end: range.end });
        return;
      }

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes',
        ...securityHeaders,
      });
      streamFile();
      return;
    }

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stats.size,
      ...securityHeaders,
    });
    streamFile();
  })
);

module.exports = router;
