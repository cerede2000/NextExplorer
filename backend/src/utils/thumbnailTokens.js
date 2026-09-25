const crypto = require('crypto');

const { thumbnailAccess } = require('../config/index');

/**
 * Thumbnails are served from /static, outside the auth middleware, so the URL
 * has to carry its own proof of access.
 *
 * A session cookie could not do that job: it says who the caller is, not what
 * they were allowed to see. A share visitor with a valid session for share A
 * could ask for any cached filename, including one belonging to share B or to
 * a private folder — the cache name is derived from the path, so it is
 * guessable. This token is minted only by /api/thumbnails, which runs the full
 * access check first, and it names the one file it unlocks.
 */
// Matches the guest session lifetime: a page left open longer than this
// refetches its thumbnails through /api, which re-runs the access check.
const TTL_MS = 24 * 60 * 60 * 1000;

const sign = (filename, expiresAt) =>
  crypto
    .createHmac('sha256', thumbnailAccess.secret)
    .update(`${filename}:${expiresAt}`)
    .digest('base64url');

const createThumbnailToken = (filename, now = Date.now()) => {
  const expiresAt = now + TTL_MS;
  return `${expiresAt}.${sign(filename, expiresAt)}`;
};

/**
 * @returns {boolean} true when the token was issued for this exact filename
 * and has not expired.
 */
const verifyThumbnailToken = (filename, token, now = Date.now()) => {
  if (typeof filename !== 'string' || typeof token !== 'string') return false;

  const separator = token.indexOf('.');
  if (separator <= 0) return false;

  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;

  const provided = Buffer.from(token.slice(separator + 1), 'utf8');
  const expected = Buffer.from(sign(filename, expiresAt), 'utf8');
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
};

/**
 * Append the token to a /static/thumbnails URL produced by the service layer.
 * Anything that is not such a URL (an empty string, a /api/preview fallback)
 * is returned untouched.
 */
const withThumbnailToken = (url) => {
  if (typeof url !== 'string' || !url.startsWith('/static/thumbnails/')) return url;
  const filename = url.slice('/static/thumbnails/'.length);
  if (!filename || filename.includes('/') || filename.includes('?')) return url;
  return `${url}?t=${createThumbnailToken(filename)}`;
};

module.exports = {
  TTL_MS,
  createThumbnailToken,
  verifyThumbnailToken,
  withThumbnailToken,
};
