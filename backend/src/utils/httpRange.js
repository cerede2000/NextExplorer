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
