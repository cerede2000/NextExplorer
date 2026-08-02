const path = require('path');
const { mimeTypes } = require('../config/index');

/**
 * Lowercase extension of a filename, without the dot.
 *
 * Returns '' when there is none — a dotfile like `.env` has no extension, and
 * neither does `Makefile`. The editors each had their own copy of this, and
 * they disagreed: one returned the whole filename when there was no dot, which
 * then looked up a bogus MIME type.
 */
const toExtension = (filename = '') => {
  const base = path.basename(String(filename));
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index + 1).toLowerCase() : '';
};

const resolveMimeType = (extension) => mimeTypes[extension] || 'application/octet-stream';

module.exports = { toExtension, resolveMimeType };
