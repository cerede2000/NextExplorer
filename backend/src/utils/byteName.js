const { ValidationError } = require('../errors/AppError');

/**
 * A name as the disk holds it, written down so it can travel as text.
 *
 * A name on a filesystem is bytes. JSON, a URL and this application's logical
 * paths are text, and the conversion loses: Node decodes a name's bytes as
 * UTF-8 and puts U+FFFD where it cannot, and that character re-encodes to three
 * bytes where the disk holds one. `Contrôle` written the Windows way is eight
 * bytes on disk and ten in the path built back from the decoded name, so the
 * rebuilt path names nothing. Phase one made every walk count such an entry
 * instead of dying or hiding it; this is the part that makes it reachable.
 *
 * So a name that is valid UTF-8 travels as itself — which is every name on
 * every volume anybody has ever asked about, and the reason nothing else in
 * this application has to change for them — and a name that is not travels as
 * MARKER + lowercase hex of its bytes.
 *
 * The marker is U+FFFE, a permanent noncharacter: Unicode will never assign it,
 * so no name means to start with one. "Means to" is not "cannot", though, and a
 * mapping that is only injective in practice is not injective. So a name that
 * does decode and *does* start with the marker is encoded too — the two sets
 * are then disjoint by construction, and `decode(encode(bytes))` is `bytes` for
 * every possible sequence of bytes rather than for the ones nobody tried.
 *
 * Hex rather than base64 because a path carrying one of these is read by people
 * — in a log, in a bug report, in a test — and `ef bf be 43 6f 6e 74 72 f4` can
 * be read. These names are rare enough that twice the length costs nothing.
 */

/** U+FFFE: a noncharacter, so nothing on a disk is spelled with one on purpose. */
const MARKER = '￾';

/** What a decoded name may never contain, whatever the client sends. */
const PATH_SEPARATOR = 0x2f;
const NUL = 0x00;

/** Whether `text` is the written-down form rather than a name itself. */
const isEncodedName = (text) => typeof text === 'string' && text.startsWith(MARKER);

/**
 * Whether `bytes` has to be written down rather than carried as text.
 *
 * Either because it does not decode, or because it decodes to something that
 * would be read back as the written-down form.
 */
const needsEncoding = (bytes) => {
  const text = bytes.toString('utf8');
  return isEncodedName(text) || !Buffer.from(text, 'utf8').equals(bytes);
};

/**
 * `bytes` as a single path segment of text: itself when it can be, written down
 * when it cannot.
 */
const encodeName = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  if (!needsEncoding(buffer)) return buffer.toString('utf8');
  return `${MARKER}${buffer.toString('hex')}`;
};

/**
 * The bytes a segment of text names.
 *
 * This is where a client's input becomes a path on disk, so it is where the
 * written-down form is checked rather than trusted: `￾2e2e2f` would
 * otherwise be a `../` nothing upstream of here could see, since every
 * traversal check in this application reads text. A segment is one name, so a
 * separator or a NUL in it is refused outright rather than normalised away.
 */
const decodeName = (text) => {
  const value = String(text ?? '');
  if (!isEncodedName(value)) return Buffer.from(value, 'utf8');

  const hex = value.slice(MARKER.length);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new ValidationError('This name is not spelled in a way the server can read.');
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.includes(PATH_SEPARATOR) || bytes.includes(NUL)) {
    throw new ValidationError('Name cannot contain path separators.');
  }
  // A name that did not need writing down must not arrive written down: two
  // spellings of one entry are two identities for it, and everything from a
  // cache key to a favourite is kept under the one the listing gave.
  if (!needsEncoding(bytes)) {
    throw new ValidationError('This name is not spelled in a way the server can read.');
  }
  return bytes;
};

/**
 * `bytes` as something to show somebody: what it says where it can be read, and
 * U+FFFD where it cannot. Never used to reach the entry — `encodeName` is.
 */
const displayName = (bytes) =>
  (Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')).toString('utf8');

module.exports = {
  MARKER,
  isEncodedName,
  needsEncoding,
  encodeName,
  decodeName,
  displayName,
};
