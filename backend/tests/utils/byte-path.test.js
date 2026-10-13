import { describe, expect, it } from 'vitest';
import bytePath from '../../src/utils/bytePath.js';

/**
 * Path arithmetic on bytes, and the rule that keeps it from spreading.
 *
 * A path is a string whenever its bytes are valid UTF-8 and a Buffer only when
 * they are not — so every path on every volume anybody has looked at stays a
 * string, no caller changes behaviour, and the Buffer form reaches only the
 * entries that were unreachable before. These tests are mostly about that
 * narrowing: the arithmetic is the easy half.
 */

const CP1252 = Buffer.from('436f6e7472f46c65', 'hex');

describe('a path built out of bytes', () => {
  describe('the form it comes back as', () => {
    it('is a string when every byte decodes, which is the ordinary case', () => {
      expect(bytePath.join('/mnt/volume', 'Documents', 'Rapport.docx')).toBe(
        '/mnt/volume/Documents/Rapport.docx'
      );
    });

    it('is a string for a name outside ASCII, which also decodes', () => {
      expect(bytePath.join('/mnt', 'Contrôle')).toBe('/mnt/Contrôle');
    });

    it('is a Buffer as soon as one segment does not decode', () => {
      const joined = bytePath.join('/mnt/volume', CP1252);

      expect(Buffer.isBuffer(joined)).toBe(true);
      expect(joined).toEqual(Buffer.concat([Buffer.from('/mnt/volume/'), CP1252]));
    });

    it('stays a Buffer for everything built under such a segment', () => {
      const folder = bytePath.join('/mnt', CP1252);

      const inside = bytePath.join(folder, 'inside.txt');

      expect(Buffer.isBuffer(inside)).toBe(true);
      expect(inside).toEqual(
        Buffer.concat([Buffer.from('/mnt/'), CP1252, Buffer.from('/inside.txt')])
      );
    });

    /**
     * The narrowing has to check the round trip rather than trust
     * `toString('utf8')`, which answers a string for anything — U+FFFD
     * included, which is the lossy step this module exists to avoid.
     */
    it('is never narrowed back to a string by losing bytes', () => {
      expect(bytePath.fromBytes(CP1252)).toEqual(CP1252);
      expect(bytePath.fromBytes(Buffer.from('Contrôle'))).toBe('Contrôle');
    });
  });

  describe('taking a path apart', () => {
    it('answers the last segment', () => {
      expect(bytePath.basename('/mnt/volume/Rapport.docx')).toBe('Rapport.docx');
      expect(bytePath.basename(bytePath.join('/mnt', CP1252))).toEqual(CP1252);
    });

    it('answers the folder above', () => {
      expect(bytePath.dirname('/mnt/volume/Rapport.docx')).toBe('/mnt/volume');
      expect(bytePath.dirname(bytePath.join('/mnt/volume', CP1252))).toBe('/mnt/volume');
    });

    it('stops at the root rather than answering nothing', () => {
      expect(bytePath.dirname('/one')).toBe('/');
    });

    it('answers a path with no separator as itself', () => {
      expect(bytePath.dirname('alone')).toBe('alone');
    });
  });

  describe('whether a path is inside a root', () => {
    it('says yes for the root itself', () => {
      expect(bytePath.isWithin('/mnt/volume', '/mnt/volume')).toBe(true);
    });

    it('says yes for something under it, bytes or not', () => {
      expect(bytePath.isWithin('/mnt/volume/Docs', '/mnt/volume')).toBe(true);
      expect(bytePath.isWithin(bytePath.join('/mnt/volume', CP1252), '/mnt/volume')).toBe(true);
    });

    /** The classic: a sibling whose name starts with the root's. */
    it('says no for a sibling the root’s name is a prefix of', () => {
      expect(bytePath.isWithin('/mnt/volume-other/Docs', '/mnt/volume')).toBe(false);
    });

    it('says no for something above it', () => {
      expect(bytePath.isWithin('/mnt', '/mnt/volume')).toBe(false);
    });

    it('does not mind a root that already ends in a separator', () => {
      expect(bytePath.isWithin('/mnt/volume/Docs', '/mnt/volume/')).toBe(true);
    });
  });

  it('compares two paths by their bytes, whichever form each is in', () => {
    expect(bytePath.equals('/mnt/Contrôle', Buffer.from('/mnt/Contrôle'))).toBe(true);
    expect(bytePath.equals(CP1252, Buffer.from('Contr�le'))).toBe(false);
  });
});
