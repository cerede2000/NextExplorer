const path = require('path');

/**
 * Path arithmetic that survives a name the disk holds in bytes it cannot
 * decode.
 *
 * `path.join` and its neighbours work on text. Handing them a name with U+FFFD
 * in it builds a path that leads nowhere, which is the whole defect. Node's own
 * `fs` has no such trouble: every function that takes a path takes a Buffer
 * just as happily, so the fix is to do the arithmetic on bytes and hand `fs` a
 * Buffer.
 *
 * The rule that keeps this from spreading through the application: a path is a
 * string whenever its bytes are valid UTF-8, and a Buffer only when they are
 * not. Every path on every volume anybody has ever looked at stays a string, so
 * no caller changes behaviour, nothing is serialised differently, and a log line
 * reads as it always did. Only the entries that were unreachable travel as
 * Buffers, and they travel as Buffers all the way to `fs`.
 */

const SEPARATOR = Buffer.from(path.sep, 'utf8');

/** A path as bytes, whichever of the two forms it arrived in. */
const toBytes = (target) =>
  Buffer.isBuffer(target) ? target : Buffer.from(String(target), 'utf8');

/**
 * Bytes back as a path: a string when they decode, the bytes themselves when
 * they do not.
 *
 * This is the narrowing that keeps the Buffer form rare. `toString('utf8')`
 * alone would answer a string for anything, U+FFFD included, which is exactly
 * the lossy step this module exists to avoid — so the round trip is checked
 * rather than assumed.
 */
const fromBytes = (bytes) => {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
};

/** Whether this path has to stay in its Buffer form to name anything. */
const isByteOnly = (target) => Buffer.isBuffer(target);

/** `base` with `segments` under it, as a string when it can be and bytes when it cannot. */
const join = (base, ...segments) => {
  const parts = [toBytes(base)];
  for (const segment of segments) {
    const bytes = toBytes(segment);
    if (bytes.length === 0) continue;
    parts.push(SEPARATOR, bytes);
  }
  return fromBytes(Buffer.concat(parts));
};

/** The part of `target` after its last separator. */
const basename = (target) => {
  const bytes = toBytes(target);
  const at = bytes.lastIndexOf(SEPARATOR[0]);
  return fromBytes(at === -1 ? bytes : bytes.subarray(at + 1));
};

/** Everything before `target`'s last separator, or `target` when there is none. */
const dirname = (target) => {
  const bytes = toBytes(target);
  const at = bytes.lastIndexOf(SEPARATOR[0]);
  if (at === -1) return fromBytes(bytes);
  // The root: `/a` has `/` above it, not the empty string.
  if (at === 0) return fromBytes(bytes.subarray(0, 1));
  return fromBytes(bytes.subarray(0, at));
};

/** Whether `target` is `root` itself or something under it. */
const isWithin = (target, root) => {
  const bytes = toBytes(target);
  const rootBytes = toBytes(root);
  if (bytes.equals(rootBytes)) return true;
  const prefix =
    rootBytes[rootBytes.length - 1] === SEPARATOR[0]
      ? rootBytes
      : Buffer.concat([rootBytes, SEPARATOR]);
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
};

/** Whether two paths name the same thing. */
const equals = (a, b) => toBytes(a).equals(toBytes(b));

module.exports = {
  SEPARATOR,
  toBytes,
  fromBytes,
  isByteOnly,
  join,
  basename,
  dirname,
  isWithin,
  equals,
};
