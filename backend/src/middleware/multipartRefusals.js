const multer = require('multer');

/**
 * A size as a person reads it: "2 MB", "64 GB".
 */
const describeBytes = (bytes) => {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
};

/**
 * Run a multer middleware whose refusals say what this route's limits are.
 *
 * multer names the limit a request met and not its value — "File too large" —
 * and only the route knows the value, and the setting that governs it. The
 * sentence for a code is attached here; the status comes from the error
 * handler, which knows every code whichever route raised it.
 *
 * @param {import('express').RequestHandler} middleware what `upload.single()` or `.fields()` returned
 * @param {Record<string, string>} sentences what to tell the client, by multer error code
 */
const explainMultipartRefusals = (middleware, sentences) => (req, res, next) =>
  middleware(req, res, (error) => {
    if (error instanceof multer.MulterError && sentences[error.code]) {
      error.clientMessage = sentences[error.code];
    }
    next(error);
  });

module.exports = { describeBytes, explainMultipartRefusals };
