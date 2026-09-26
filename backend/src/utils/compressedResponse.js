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
 * gzip at level 4. gzip is what a browser asks for over plain http — `br` is
 * only advertised over HTTPS — so this is the level a server reached by its
 * local address uses, and it decides two things: how long the first transfer
 * takes, and whether the browser keeps the answer at all.
 *
 * Measured asynchronously on 20 MB of JSON, made once of this repository's own
 * code and documentation (repeated to reach the size, which gzip's 32 KB window
 * cannot see) and once of 5,000 distinct files that never repeat:
 *
 *            repository        distinct files
 *   level 1  5.74 MB   96 ms   4.15 MB   70 ms
 *   level 3  5.37 MB  123 ms   3.88 MB   88 ms
 *   level 4  4.98 MB  143 ms   3.58 MB  111 ms
 *   level 6  4.74 MB  251 ms   3.39 MB  183 ms
 *
 * On a local network level 1 arrives first, by a few tens of milliseconds. It
 * loses on the second count: a browser caps each entry of its cache by the
 * bytes it stores, which are the compressed ones. A Chromium measured here kept
 * a 5.9 MB answer and not a 6.4 MB one — what a 20 MB Markdown file came to at
 * level 1; it came to 5.6 MB at level 4. Past that cap every opening of the file
 * is the whole download again, which costs far more than the 40 to 60 ms level
 * 4 adds. Level 6 saves little more for nearly twice the time, and each of
 * those milliseconds holds one of the four threads file reads share.
 */
const GZIP_LEVEL = 4;

/**
 * Brotli at quality 4: on the same bodies, 4.24 MB in 109 ms and 2.61 MB in
 * 77 ms — smaller than gzip at any level, in the time of gzip level 1 to 4.
 * Quality 5 took 203 ms for 3.99 MB and 135 ms for 2.41 MB. Offered over HTTPS,
 * where the link is more often the slow part.
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
