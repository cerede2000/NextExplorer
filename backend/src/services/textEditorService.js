const crypto = require('crypto');
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
};

/**
 * What the editor refuses before it has read a byte: a directory, a file past
 * the limit, a format the editor is not for.
 */
const refuseUnopenable = (absolutePath, stats) => {
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
};

/**
 * And what it refuses once it has seen the start of the file.
 *
 * The decoded text is passed in when the caller already has it; UTF-16 is
 * judged by its characters, so without it the bytes are decoded here.
 */
const refuseBinary = (buffer, detected, decoded = null) => {
  const binary =
    detected.encoding === 'utf8'
      ? isProbablyBinaryBuffer(buffer)
      : isProbablyBinaryText(decoded ?? decodeText(buffer, detected));

  if (binary) {
    throw new UnsupportedMediaTypeError(
      'This file appears to be binary and cannot be opened in the text editor.'
    );
  }
};

/** The first `byteCount` bytes of a file, or as many of them as there are. */
const readHead = async (absolutePath, byteCount) => {
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const head = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(head, 0, byteCount, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle?.close();
  }
};

async function readTextFile(absolutePath) {
  const stats = await fs.stat(absolutePath);
  refuseUnopenable(absolutePath, stats);

  const buffer = await fs.readFile(absolutePath);
  const detected = detectTextEncoding(buffer);
  const text = decodeText(buffer, detected);
  refuseBinary(buffer, detected, text);

  return { buffer, stats, text, encoding: detected };
}

/**
 * How much of a file the judgements above need to reach the verdict the whole
 * file would reach.
 *
 * Twice the sample, because the only one of them that looks at characters
 * rather than bytes looks at SAMPLE_BYTES of them, and in UTF-16 a character
 * is two bytes. Detection needs no more: a mark is three bytes and the pairing
 * test caps itself at SAMPLE_BYTES either way.
 */
const HEAD_BYTES = SAMPLE_BYTES * 2;

/**
 * What a save needs to know about the file it is replacing: that the editor
 * would have opened it at all, and what it is written in.
 *
 * Every refusal `readTextFile` makes, made from the stat and the head of the
 * file rather than from the whole of it — which is all any of them ever
 * looked at. The save through a share link asked `readTextFile` for the
 * encoding alone and so read and decoded up to a megabyte to look at three
 * bytes.
 *
 * @returns {Promise<{stats: import('fs').Stats, encoding: {encoding: string, bom: boolean}}>}
 */
async function readTextFileHead(absolutePath) {
  const stats = await fs.stat(absolutePath);
  refuseUnopenable(absolutePath, stats);

  const head = await readHead(absolutePath, HEAD_BYTES);
  const detected = detectTextEncoding(head);
  refuseBinary(head, detected);

  return { stats, encoding: detected };
}

/**
 * Bumped whenever `readTextFile` would make something different of the same
 * bytes: how an encoding is detected, a mark stripped, what counts as binary.
 * It is part of the identity below, so a browser holding text decoded under the
 * old rules is not told by a 304 that its copy is still right.
 */
const TEXT_READING_VERSION = 1;

/**
 * The identity of the text a file answers with, as a weak ETag, made from the
 * file's metadata alone so that an unchanged file can be answered 304 without
 * being read.
 *
 * Taken from a bigint stat — an inode past 2^53 and a time in nanoseconds do
 * not survive a double — and made of:
 *  - the inode: a save writes a new file and renames it over the old one, so a
 *    save that comes out the same size within one clock tick still differs;
 *  - the size and the modification time: a write in place;
 *  - the change time: a write in place that put the modification time back, as
 *    `cp -p`, `rsync --inplace -t` or an archive extracted over the file do.
 *    Nothing can put that one back;
 *  - `describe`, hashed: whatever else the answer carries, so that a change
 *    there — a share turned read-only — is never hidden behind a 304.
 *
 * Weak, because the same text goes compressed or not: equivalent answers, not
 * the same bytes.
 *
 * The stat has to be taken before the file is read. Content changing between
 * the two then pairs newer text with an older identity, which costs the next
 * visit one download; the other order pairs older text with a newer identity,
 * and every 304 after it would keep the older text.
 *
 * @param {import('fs').BigIntStats} stats
 * @param {object} [describe]
 */
const textFileEtag = (stats, describe) => {
  const parts = [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map((value) =>
    value.toString(36)
  );
  parts.push(`t${TEXT_READING_VERSION}`);
  if (describe !== undefined) {
    const digest = crypto.createHash('sha256').update(JSON.stringify(describe)).digest('base64url');
    parts.push(digest.slice(0, 16));
  }
  return `W/"${parts.join('-')}"`;
};

/**
 * The encoding a file already on disk is written in, so a save keeps it.
 *
 * Reads only the head of the file: a mark is the first three bytes, and the
 * pairing that betrays a markless UTF-16 shows in the first few hundred.
 */
async function readFileEncoding(absolutePath) {
  try {
    return detectTextEncoding(await readHead(absolutePath, SAMPLE_BYTES));
  } catch (_) {
    // No file yet: a new one is written in the encoding everything else uses.
    return { encoding: 'utf8', bom: false };
  }
}

module.exports = {
  readTextFile,
  readTextFileHead,
  readFileEncoding,
  detectTextEncoding,
  decodeText,
  encodeText,
  textFileEtag,
  MAX_EDITOR_FILE_SIZE,
};
