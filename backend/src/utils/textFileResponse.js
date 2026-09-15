const fs = require('fs/promises');

const { readTextFile, textFileEtag } = require('../services/textEditorService');
const { sendCompressible } = require('./compressedResponse');

/**
 * Kept by the browser and never used without asking: every use is a
 * revalidation, answered 304 while the file is unchanged. `private` keeps it
 * out of any cache shared between people — what someone may read is decided
 * for that person.
 */
const CACHE_CONTROL = 'private, no-cache';

/**
 * Whether the request's If-None-Match names this identity.
 *
 * Weak comparison, which is the one If-None-Match uses: `W/"x"` and `"x"` are
 * the same tag. A request saying `Cache-Control: no-cache` — a reload — wants
 * the file itself and gets it.
 */
const isNotModified = (req, etag) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const header = req.headers['if-none-match'];
  if (!header) return false;
  if (/(?:^|,)\s*no-cache\s*(?:,|$)/i.test(req.headers['cache-control'] || '')) return false;

  const opaque = (tag) => tag.replace(/^W\//, '');
  const wanted = opaque(etag);
  const tags = header.match(/\*|(?:W\/)?"[^"]*"/g) || [];
  return tags.some((tag) => tag === '*' || opaque(tag) === wanted);
};

/**
 * Answer with the text of a file the caller has already allowed this request
 * to read — 304 when the browser holds it unchanged.
 *
 * Authorization and resolution belong to the caller and come first, always:
 * somebody who may not read the file gets the refusal they always got, never a
 * 304 telling them their copy is current.
 *
 * The identity is put on the answer only once there is an answer — a 304, or
 * the text read and ready. An error carrying an ETag and `private` may be kept
 * by the browser and revalidated like anything else, and a 304 would then keep
 * a failure that was only momentary.
 *
 * @param {object} options
 * @param {string} options.absolutePath
 * @param {(textFile: object) => object|string} options.render  the body, from what readTextFile answers
 * @param {object} [options.describe]  what else the body carries, made part of its identity
 * @param {Record<string, string>} [options.headers]  sent with the text, and with a 304
 * @param {() => Promise<void>} [options.onAnswer]  once the answer is decided, before it goes
 */
const sendTextFile = async (
  req,
  res,
  { absolutePath, render, describe, headers = {}, onAnswer }
) => {
  const stats = await fs.stat(absolutePath, { bigint: true });
  const etag = textFileEtag(stats, describe);

  // Only a file was ever given an identity; anything else goes on to the read,
  // which says what is wrong with it.
  if (stats.isFile() && isNotModified(req, etag)) {
    await onAnswer?.();
    res.set({ ...headers, ETag: etag, 'Cache-Control': CACHE_CONTROL });
    res.vary('Accept-Encoding');
    res.status(304).end();
    return;
  }

  const body = render(await readTextFile(absolutePath));
  await onAnswer?.();
  res.set({ ...headers, ETag: etag, 'Cache-Control': CACHE_CONTROL });
  await sendCompressible(req, res, body);
};

module.exports = { sendTextFile, isNotModified, CACHE_CONTROL };
