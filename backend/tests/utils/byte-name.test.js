import { describe, expect, it } from 'vitest';
import {
  MARKER,
  decodeName,
  displayName,
  encodeName,
  isEncodedName,
  needsEncoding,
} from '../../src/utils/byteName.js';

/**
 * Writing a name down so it can travel as text, and reading it back.
 *
 * The property that matters is injectivity: every possible sequence of bytes has
 * exactly one written form, and no two sequences share one. A mapping that holds
 * for the names somebody happened to try is not injective — it is a mapping with
 * a bug nobody has reached yet — so the awkward cases are here by name: a name
 * that already starts with the marker, a name that is only partly invalid, the
 * empty name, and the bytes a traversal would be smuggled in as.
 */

/** `Contrôle`, with `ô` as the single byte 0xF4 a Windows-era volume holds. */
const CP1252 = Buffer.from('436f6e7472f46c65', 'hex');

describe('a name written down so it can travel as text', () => {
  describe('a name that is valid UTF-8', () => {
    it('travels as itself, so nothing else in the application changes for it', () => {
      expect(encodeName(Buffer.from('Rapport.docx'))).toBe('Rapport.docx');
    });

    it('travels as itself when it is not ASCII either', () => {
      expect(encodeName(Buffer.from('Contrôle du niveau d’huile'))).toBe(
        'Contrôle du niveau d’huile'
      );
    });

    it('is read back as the bytes it came from', () => {
      const bytes = Buffer.from('Contrôle');
      expect(decodeName(encodeName(bytes))).toEqual(bytes);
    });
  });

  describe('a name that is not valid UTF-8', () => {
    it('is written down, marker first', () => {
      expect(encodeName(CP1252)).toBe(`${MARKER}436f6e7472f46c65`);
    });

    it('is read back byte for byte, which is the whole point', () => {
      expect(decodeName(encodeName(CP1252))).toEqual(CP1252);
    });

    it('is shown with the replacement character, for the eye and never to reach it', () => {
      expect(displayName(CP1252)).toBe('Contr�le');
    });
  });

  /**
   * The case that makes the mapping injective rather than nearly injective.
   *
   * U+FFFE is a noncharacter, so no name means to start with one — but a
   * filesystem will hold such a name, and then its written form and a written
   * form would be indistinguishable. It is therefore written down too, although
   * it decodes perfectly well.
   */
  describe('a name that decodes and starts with the marker anyway', () => {
    const awkward = Buffer.from(`${MARKER}436f6e74`, 'utf8');

    it('is written down, so it cannot be read as another name’s written form', () => {
      expect(needsEncoding(awkward)).toBe(true);
      expect(encodeName(awkward)).toBe(`${MARKER}${awkward.toString('hex')}`);
    });

    it('is read back as itself and not as the name it imitates', () => {
      expect(decodeName(encodeName(awkward))).toEqual(awkward);
      expect(decodeName(encodeName(awkward))).not.toEqual(Buffer.from('Cont'));
    });

    it('is not the same written form as the name it imitates', () => {
      expect(encodeName(awkward)).not.toBe(encodeName(Buffer.from('Cont')));
    });
  });

  describe('what a client sends', () => {
    it('cannot smuggle a traversal through the written-down form', () => {
      const traversal = `${MARKER}${Buffer.from('../../etc').toString('hex')}`;

      expect(() => decodeName(traversal)).toThrow(/path separators/);
    });

    it('cannot smuggle a NUL either', () => {
      const nul = `${MARKER}${Buffer.from([0x61, 0x00, 0x62]).toString('hex')}`;

      expect(() => decodeName(nul)).toThrow(/path separators/);
    });

    it('is refused when the hex is not hex', () => {
      expect(() => decodeName(`${MARKER}zzz`)).toThrow();
      expect(() => decodeName(`${MARKER}abc`)).toThrow();
    });

    /**
     * One entry, one identity. A name that never needed writing down must not
     * arrive written down, or the same file has two spellings — and everything
     * from a favourite to a thumbnail cache is kept under the one the listing
     * gave out.
     */
    it('is refused when a perfectly readable name arrives written down', () => {
      const pointless = `${MARKER}${Buffer.from('Rapport.docx').toString('hex')}`;

      expect(() => decodeName(pointless)).toThrow();
    });
  });

  describe('the round trip', () => {
    it('holds for every single byte on its own', () => {
      for (let byte = 1; byte < 256; byte += 1) {
        const bytes = Buffer.from([byte]);
        expect(decodeName(encodeName(bytes)), `byte ${byte}`).toEqual(bytes);
      }
    });

    it('holds for a name that is partly readable', () => {
      const mixed = Buffer.concat([
        Buffer.from('été-'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('.txt'),
      ]);

      expect(decodeName(encodeName(mixed))).toEqual(mixed);
    });

    it('tells an encoded name from a name', () => {
      expect(isEncodedName(encodeName(CP1252))).toBe(true);
      expect(isEncodedName('Rapport.docx')).toBe(false);
    });
  });
});
