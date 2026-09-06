const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const { ValidationError, UnsupportedMediaTypeError } = require('../errors/AppError');

const MAX_EDITOR_FILE_SIZE = config.editor?.maxFileSizeBytes ?? 1 * 1024 * 1024;
const VIDEO_EXTENSIONS = Array.isArray(config.extensions?.videos) ? config.extensions.videos : [];

/**
 * How much of a file is enough to tell text from anything else.
 */
const SAMPLE_BYTES = 4096;

/**
 * How much of a file the pairing test below needs before it is worth believing.
 */
const UTF16_MIN_SAMPLE_BYTES = 16;

/**
 * The byte-order marks that say outright what a file is written in.
 *
 * UTF-16LE's mark is two bytes, and UTF-32LE's is those same two followed by
 * two zeros — so the longer marks are tried first.
 */
const BYTE_ORDER_MARKS = [
  { encoding: 'utf8', bytes: [0xef, 0xbb, 0xbf] },
  { encoding: 'utf16le', bytes: [0xff, 0xfe] },
  { encoding: 'utf16be', bytes: [0xfe, 0xff] },
];

/**
 * Whether a run of bytes looks like one half of UTF-16.
 *
 * In UTF-16 every character in the Latin range is stored as two bytes, one of
 * which is zero — the low byte first in little-endian, second in big-endian.
 * So a zero byte falling consistently on one side of each pair, and never on
 * the other, is the shape of UTF-16 text rather than the shape of a file that
 * happens to contain a zero.
 */
const looksLikeUtf16 = (buffer, zeroAtOddIndex) => {
  const length = Math.min(buffer.length, SAMPLE_BYTES) & ~1;
  // Too short to show a pattern: three bytes of a PNG header would otherwise
  // reach the ratio below on their own.
  if (length < UTF16_MIN_SAMPLE_BYTES) return false;

  let zerosWhereExpected = 0;
  for (let index = 0; index < length; index += 2) {
    const [expected, other] = zeroAtOddIndex
      ? [buffer[index + 1], buffer[index]]
      : [buffer[index], buffer[index + 1]];
    // A zero on the wrong side is not this encoding.
    if (other === 0) return false;
    // Nor is a pair whose other half is a control byte: that is the shape of a
    // file that merely contains zeros, not of text stored two bytes at a time.
    if (expected === 0 && (other < 7 || (other > 13 && other < 32))) return false;
    if (expected === 0) zerosWhereExpected += 1;
  }

  return zerosWhereExpected / (length / 2) > 0.3;
};

/**
 * What a text file is actually written in.
 *
 * This exists because of one number: in UTF-16, every ASCII character is
 * accompanied by a zero byte, and a zero byte is exactly what "this file is
 * binary" looks for. PowerShell's `Out-File` wrote UTF-16LE by default until
 * PowerShell 6, and Windows Notepad still offers it as "Unicode", so an export
 * or a log from a Windows machine is very often UTF-16 — and was answered with
 * "this file appears to be binary and cannot be opened", about a plain text
 * file, with no way to tell what was actually meant.
 *
 * A mark is believed when there is one. Otherwise the pairing above decides,
 * because plenty of tools write UTF-16 without one.
 *
 * @returns {{encoding: 'utf8'|'utf16le'|'utf16be', bom: boolean}}
 */
const detectTextEncoding = (buffer) => {
  for (const { encoding, bytes } of BYTE_ORDER_MARKS) {
    if (buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte)) {
      return { encoding, bom: true };
    }
  }

  if (looksLikeUtf16(buffer, true)) return { encoding: 'utf16le', bom: false };
  if (looksLikeUtf16(buffer, false)) return { encoding: 'utf16be', bom: false };

  return { encoding: 'utf8', bom: false };
};

/** The characters in a file, whatever it is written in, without its mark. */
const decodeText = (buffer, { encoding, bom }) => {
  if (encoding === 'utf16be') {
    // Node decodes little-endian only, so the pairs are swapped first — on a
    // copy, because the caller's buffer is not ours to rewrite, and on an even
    // number of bytes, because `swap16` throws on anything else and a truncated
    // file is not a reason to answer with a stack trace.
    const swapped = Buffer.from(buffer.subarray(0, buffer.length & ~1)).swap16();
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }

  const body = bom && encoding === 'utf8' ? buffer.subarray(3) : buffer;
  return body.toString(encoding === 'utf16le' ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
};

/**
 * The bytes to write for text that came out of a file of this encoding.
 *
 * A file keeps the encoding it had. Saving a UTF-16 log back as UTF-8 would
 * halve it and read perfectly well here, and break whatever wrote it — a script
 * reading it with a fixed encoding, an import expecting the mark it left.
 */
const encodeText = (text, { encoding = 'utf8', bom = false } = {}) => {
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    const content = encoding === 'utf16be' ? body.swap16() : body;
    return bom
      ? Buffer.concat([Buffer.from(encoding === 'utf16be' ? [0xfe, 0xff] : [0xff, 0xfe]), content])
      : content;
  }

  const content = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
};

/**
 * Whether what was read is a file of words at all.
 *
 * Control characters are the tell either way; what changes with the encoding is
 * what a control character is made of. Judging UTF-16 by its bytes is what
 * called text binary, so UTF-16 is judged by its characters, after decoding.
 */
function isProbablyBinaryBuffer(buffer) {
  const length = Math.min(buffer.length, SAMPLE_BYTES);
  if (!length) return false;

  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }

  return suspicious / length > 0.3;
}

const isProbablyBinaryText = (text) => {
  const length = Math.min(text.length, SAMPLE_BYTES);
  if (!length) return false;

  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) return true;
    if (code < 7 || (code > 13 && code < 32)) suspicious += 1;
  }

  return suspicious / length > 0.3;
}

async function readTextFile(absolutePath) {
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    throw new ValidationError('Cannot open a directory in the text editor.');
  }

  if (typeof stats.size === 'number' && stats.size > MAX_EDITOR_FILE_SIZE) {
    throw new ValidationError('This file is too large to open in the text editor.');
  }

  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) {
    throw new UnsupportedMediaTypeError('This file type cannot be opened in the text editor.');
  }

  const buffer = await fs.readFile(absolutePath);
  const detected = detectTextEncoding(buffer);
  const isUtf16 = detected.encoding !== 'utf8';
  const text = decodeText(buffer, detected);

  if (isUtf16 ? isProbablyBinaryText(text) : isProbablyBinaryBuffer(buffer)) {
    throw new UnsupportedMediaTypeError(
      'This file appears to be binary and cannot be opened in the text editor.'
    );
  }

  return { buffer, stats, text, encoding: detected };
}

/**
 * The encoding a file already on disk is written in, so a save keeps it.
 *
 * Reads only the head of the file: a mark is the first three bytes, and the
 * pairing that betrays a markless UTF-16 shows in the first few hundred.
 */
async function readFileEncoding(absolutePath) {
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const head = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(head, 0, SAMPLE_BYTES, 0);
    return detectTextEncoding(head.subarray(0, bytesRead));
  } catch (_) {
    // No file yet: a new one is written in the encoding everything else uses.
    return { encoding: 'utf8', bom: false };
  } finally {
    await handle?.close();
  }
}

module.exports = {
  readTextFile,
  readFileEncoding,
  detectTextEncoding,
  decodeText,
  encodeText,
  MAX_EDITOR_FILE_SIZE,
};
