import { describe, it, expect } from 'vitest';

const {
  detectTextEncoding,
  decodeText,
  encodeText,
} = require('../../src/services/textEditorService');

/**
 * The encoding a text file is written in.
 *
 * A 3.5 MB text file was refused with "this file appears to be binary and
 * cannot be opened in the text editor", which is both wrong and impossible to
 * act on. The file was UTF-16: every ASCII character carries a zero byte
 * alongside it, and a zero byte is exactly what the binary test looks for.
 *
 * That is not an exotic case. PowerShell's `Out-File` wrote UTF-16LE by default
 * until PowerShell 6 and Windows Notepad still offers it as "Unicode", so a log
 * or an export from a Windows machine is very often UTF-16.
 */

const utf16le = (text, { bom = false } = {}) => {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
};

const utf16be = (text, { bom = false } = {}) => {
  const body = Buffer.from(text, 'utf16le').swap16();
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
};

const utf8 = (text, { bom = false } = {}) => {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
};

const LOG = 'Nom de la machine : POSTE-042\r\nStatut : à jour\r\n'.repeat(40);

describe('what a file is written in', () => {
  it('is UTF-8 when nothing says otherwise', () => {
    expect(detectTextEncoding(utf8(LOG))).toEqual({ encoding: 'utf8', bom: false });
  });

  it('is what the mark says, when there is one', () => {
    expect(detectTextEncoding(utf8(LOG, { bom: true }))).toEqual({
      encoding: 'utf8',
      bom: true,
    });
    expect(detectTextEncoding(utf16le(LOG, { bom: true }))).toEqual({
      encoding: 'utf16le',
      bom: true,
    });
    expect(detectTextEncoding(utf16be(LOG, { bom: true }))).toEqual({
      encoding: 'utf16be',
      bom: true,
    });
  });

  /** Plenty of tools write UTF-16 without a mark, and it is still UTF-16. */
  it('is UTF-16 when the zero bytes fall where UTF-16 puts them', () => {
    expect(detectTextEncoding(utf16le(LOG))).toEqual({ encoding: 'utf16le', bom: false });
    expect(detectTextEncoding(utf16be(LOG))).toEqual({ encoding: 'utf16be', bom: false });
  });

  /** A zero on both sides of the pairs is not one encoding read wrongly. */
  it('is not UTF-16 for something that merely holds zeros', () => {
    const binary = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00]);

    expect(detectTextEncoding(binary).encoding).toBe('utf8');
  });

  /**
   * Two bytes are "A" in UTF-16BE and a zero followed by "A" in UTF-8, and
   * nothing in them settles which. Too little to go on is answered by the
   * ordinary reading, which then refuses it for the zero it holds.
   */
  it('is UTF-8 for a file too short to show a pattern', () => {
    expect(detectTextEncoding(Buffer.from([0x00, 0x41])).encoding).toBe('utf8');
  });

  /** Three bytes of a PNG header would reach the ratio on their own. */
  it('is not UTF-16 for a handful of bytes that happen to alternate', () => {
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]);

    expect(detectTextEncoding(pngHead).encoding).toBe('utf8');
  });

  /**
   * In real UTF-16 the half beside the zero is a character. A zero paired with
   * a control byte is a file that merely contains zeros.
   */
  it('is not UTF-16 when the other half of each pair is not text', () => {
    const alternating = Buffer.alloc(64);
    for (let index = 0; index < alternating.length; index += 2) alternating[index + 1] = 0x03;

    expect(detectTextEncoding(alternating).encoding).toBe('utf8');
  });

  /** A file cut mid-character must not answer with a stack trace. */
  it('reads a big-endian file that stops in the middle of a character', () => {
    const truncated = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from('Bonjour', 'utf16le').swap16(),
      Buffer.from([0x00]),
    ]);

    expect(decodeText(truncated, detectTextEncoding(truncated))).toBe('Bonjour');
  });

  it('is UTF-8 for nothing at all', () => {
    expect(detectTextEncoding(Buffer.alloc(0))).toEqual({ encoding: 'utf8', bom: false });
  });
});

describe('reading it back', () => {
  it.each([
    ['UTF-8', utf8],
    ['UTF-8 with a mark', (text) => utf8(text, { bom: true })],
    ['UTF-16LE', utf16le],
    ['UTF-16LE with a mark', (text) => utf16le(text, { bom: true })],
    ['UTF-16BE', utf16be],
    ['UTF-16BE with a mark', (text) => utf16be(text, { bom: true })],
  ])('gives back the words of a file written in %s', (_name, write) => {
    const buffer = write(LOG);

    expect(decodeText(buffer, detectTextEncoding(buffer))).toBe(LOG);
  });

  /** The mark is not part of what somebody typed, and must not reach them. */
  it('leaves no mark at the start of the text', () => {
    const buffer = utf16le('Bonjour', { bom: true });

    expect(decodeText(buffer, detectTextEncoding(buffer)).charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('writing it back', () => {
  it.each([
    ['UTF-8', utf8],
    ['UTF-8 with a mark', (text) => utf8(text, { bom: true })],
    ['UTF-16LE', utf16le],
    ['UTF-16LE with a mark', (text) => utf16le(text, { bom: true })],
    ['UTF-16BE', utf16be],
    ['UTF-16BE with a mark', (text) => utf16be(text, { bom: true })],
  ])('keeps a file written in %s exactly as it was', (_name, write) => {
    const original = write(LOG);

    const rewritten = encodeText(
      decodeText(original, detectTextEncoding(original)),
      detectTextEncoding(original)
    );

    expect(rewritten).toEqual(original);
  });

  /**
   * A UTF-16 log saved back as UTF-8 would halve in size and read perfectly
   * well here, while breaking whatever wrote it — a script reading it with a
   * fixed encoding, an import expecting the mark it left.
   */
  it('does not quietly convert a UTF-16 file to UTF-8', () => {
    const rewritten = encodeText('Bonjour', { encoding: 'utf16le', bom: true });

    expect(rewritten.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(rewritten.length).toBe(2 + 'Bonjour'.length * 2);
  });

  it('writes a new file in UTF-8, with nothing in front of it', () => {
    expect(encodeText('Bonjour')).toEqual(Buffer.from('Bonjour', 'utf8'));
  });
});
