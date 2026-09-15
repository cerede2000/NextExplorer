const zlib = require('zlib');
const { promisify } = require('util');

const logger = require('./logger');

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

/**
 * Sending a whole text file compressed, when the client can take it.
 *
 * The editor and the Markdown preview receive a file as one JSON document, and
 * nothing in the application compressed anything: a 19 MB Markdown file went
 * over the wire as 22 MB of JSON, twice when the editor was opened from the
 * preview. Text shrinks to a quarter of that.
 *
 * Deliberately not a global middleware. Most of what this server sends is
 * already compressed (images, video, archives, office documents), or streamed
 * with a length the client relies on for progress (downloads, ranged media), or
 * a stream of progress events that must arrive as they happen (NDJSON) — and a
 * middleware buffering or re-encoding those would break them. Only the routes
 * that answer with a whole text file in one piece call this.
 */

/**
 * Below this, a body goes as it is. Measured: a 32 KB JSON body gzips in about
 * a tenth of a millisecond to 13 KB, so what is saved under the line is a few
 * tens of kilobytes — nothing on a local network, and not worth a trip through
 * the thread pool for every small file the editor opens.
 */
const COMPRESSION_THRESHOLD_BYTES = 32 * 1024;

/**
 * gzip at level 1. Measured on 20 MB of JSON made of this repository's own code
 * and documentation, asynchronously:
 *
 *   level 1  5.74 MB   96 ms
 *   level 3  5.37 MB  123 ms
 *   level 4  4.98 MB  143 ms
 *   level 6  4.74 MB  251 ms
 *
 * gzip is what a browser asks for over plain http — `br` is only advertised
 * over HTTPS — so this is the level a server reached by its local address
 * uses. On a gigabit link level 1 arrives first (96 ms + 46 ms of transfer,
 * against 143 + 40 for level 4 and 251 + 38 for level 6); at 100 Mbit/s level 4
 * wins by 14 ms in half a second. The server may also be a NAS several times
 * slower than the machine measured, where the compression time is the whole
 * cost, and each of those milliseconds holds one of the four threads file
 * reads share.
 */
const GZIP_LEVEL = 1;

/**
 * Brotli at quality 4: 4.24 MB in 109 ms on the same body — smaller than gzip at
 * any level, in the time of gzip level 1. Quality 5 took 203 ms for 3.99 MB.
 * Offered over HTTPS, where the link is more often the slow part.
 */
const BROTLI_QUALITY = 4;

/** Below any quality a client can write (three decimals), above refusal. */
const IMPLICIT_QUALITY = 0.0001;

/**
 * The qualities an Accept-Encoding header gives each coding it names.
 *
 * A malformed quality drops its entry rather than guessing: a coding the client
 * did not clearly accept is not one to send it.
 */
const parseAcceptEncoding = (header) => {
  const qualities = new Map();
  for (const part of String(header).split(',')) {
    const [rawCoding, ...parameters] = part.split(';');
    const coding = rawCoding.trim().toLowerCase();
    if (!coding) continue;

    let quality = 1;
    let valid = true;
    for (const parameter of parameters) {
      const [name, value = ''] = parameter.split('=').map((piece) => piece.trim());
      if (name.toLowerCase() !== 'q') continue;
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) {
        valid = false;
        break;
      }
      quality = Number(value);
    }
    // The first mention of a coding is the one that counts.
    if (valid && !qualities.has(coding)) qualities.set(coding, quality);
  }
  return qualities;
};

/**
 * The content coding to answer with: 'br', 'gzip' or 'identity'.
 *
 * The client's qualities decide; between equals, the smaller result. Identity
 * is acceptable unless the header refuses it (`identity;q=0`, or `*;q=0` without
 * naming identity), and when it does refuse everything this server can produce,
 * the body still goes uncompressed — the answer HTTP allows rather than a 406
 * nobody would know what to do with.
 *
 * No header at all is read as "no preference stated", and answered
 * uncompressed: an old script or a proxy that sends none may not decode.
 */
const chooseEncoding = (header) => {
  if (typeof header !== 'string') return 'identity';
  const qualities = parseAcceptEncoding(header);
  const wildcard = qualities.get('*');
  const named = (...codings) =>
    codings.map((coding) => qualities.get(coding)).find((q) => q !== undefined);

  const candidates = [
    ['br', named('br') ?? wildcard ?? 0],
    // x-gzip is the older name, which HTTP asks recipients to treat as gzip.
    ['gzip', named('gzip', 'x-gzip') ?? wildcard ?? 0],
    ['identity', named('identity') ?? (wildcard === 0 ? 0 : IMPLICIT_QUALITY)],
  ];

  let chosen = 'identity';
  let best = 0;
  for (const [coding, quality] of candidates) {
    if (quality > best) {
      chosen = coding;
      best = quality;
    }
  }
  return chosen;
};

const compress = (encoding, payload) =>
  encoding === 'br'
    ? brotliCompress(payload, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
        },
      })
    : gzip(payload, { level: GZIP_LEVEL });

/**
 * Send `body` — an object as JSON, a string as text, a Buffer as it is —
 * compressed when it is large enough and the client accepts a coding.
 *
 * Compression runs on the thread pool: a 20 MB body compressed synchronously
 * would hold every other request for a tenth of a second or more.
 *
 * `Vary: Accept-Encoding` is set whatever is chosen, small bodies included, so
 * a cache never hands the compressed answer to a client that did not ask for
 * it, nor keeps an uncompressed one for everybody.
 */
const sendCompressible = async (req, res, body) => {
  let payload;
  let type;
  if (Buffer.isBuffer(body)) {
    payload = body;
    type = 'application/octet-stream';
  } else if (typeof body === 'string') {
    payload = Buffer.from(body, 'utf8');
    type = 'text/plain; charset=utf-8';
  } else {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    type = 'application/json; charset=utf-8';
  }

  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', type);
  res.vary('Accept-Encoding');

  const encoding =
    payload.length >= COMPRESSION_THRESHOLD_BYTES && !res.getHeader('Content-Encoding')
      ? chooseEncoding(req.headers['accept-encoding'])
      : 'identity';

  let sent = payload;
  if (encoding !== 'identity') {
    try {
      const compressed = await compress(encoding, payload);
      // Text nearly always shrinks; a body that did not is sent as it was.
      if (compressed.length < payload.length) {
        sent = compressed;
        res.setHeader('Content-Encoding', encoding);
      }
    } catch (error) {
      // The body is still there to send: a failed compression costs bytes, not
      // the answer.
      logger.warn({ err: error, encoding }, 'A response could not be compressed');
    }
  }

  res.setHeader('Content-Length', sent.length);
  res.end(sent);
};

module.exports = {
  sendCompressible,
  chooseEncoding,
  COMPRESSION_THRESHOLD_BYTES,
  GZIP_LEVEL,
  BROTLI_QUALITY,
};
