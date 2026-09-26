/**
 * Byte-range parsing for the routes that stream a file.
 *
 * The share download route and the preview route each carried their own copy
 * of this, which is how one of them ended up serving SVG without the headers
 * the other set. One implementation means one place to fix.
 */

/**
 * Interpret a Range header against a known file size.
 *
 * Returns `null` when the header is absent (send the whole file), or
 * `{ malformed: true }` / `{ unsatisfiable: true }` for a 416 — the caller
 * decides how to answer, since it owns the response.
 */
const parseByteRange = (rangeHeader, size) => {
  if (!rangeHeader) return null;

  const bytesPrefix = 'bytes=';
  if (!String(rangeHeader).startsWith(bytesPrefix)) {
    return { malformed: true };
  }

  const [startString, endString] = String(rangeHeader).slice(bytesPrefix.length).split('-');

  // "bytes=-500" asks for the last 500 bytes, not the first 501. Reading the
  // empty start as 0 turned every suffix request into a request for the head
  // of the file — silently wrong, since the response still looks valid.
  if (startString === '' && endString !== '' && endString !== undefined) {
    const suffixLength = Number(endString);
    if (Number.isNaN(suffixLength)) return { malformed: true };
    // An empty file has no last N bytes, and a zero-length suffix asks for
    // nothing: both would otherwise produce end = -1 and a bogus Content-Range.
    if (suffixLength === 0 || size === 0) return { unsatisfiable: true };
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1, chunkSize: size - start };
  }

  let start = Number(startString);
  let end = endString ? Number(endString) : size - 1;

  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end) || end >= size) end = size - 1;

  if (start > end) {
    return { unsatisfiable: true };
  }

  return { start, end, chunkSize: end - start + 1 };
};

module.exports = { parseByteRange };
