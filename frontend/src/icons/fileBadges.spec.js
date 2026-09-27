import { describe, expect, it } from 'vitest';

import { BADGES, badgeForExtension } from './fileBadges';

/**
 * The badge table, checked as a table.
 *
 * As seventy-two branches of a switch, the only way to be sure of it was to
 * read all seventy-two. What is worth asserting is not each entry — they are
 * plainly visible — but the properties that no single entry shows: that
 * nothing is claimed twice, that every colour is a colour, and that a file
 * nobody thought about falls back rather than breaking.
 */

describe('the badge for a file with no thumbnail', () => {
  it('answers for the kinds people actually have', () => {
    expect(badgeForExtension('docx')).toEqual({ label: 'DOC', bg: '#2563EB', fg: '#FFFFFF' });
    expect(badgeForExtension('py')).toEqual({ label: 'PY', bg: '#3776AB', fg: '#FFFFFF' });
    expect(badgeForExtension('woff2')).toEqual({ label: 'FONT', bg: '#9CA3AF', fg: '#111827' });
  });

  it('gives the same badge to the extensions that share one', () => {
    expect(badgeForExtension('yml')).toBe(badgeForExtension('yaml'));
    expect(badgeForExtension('cpp')).toBe(badgeForExtension('cxx'));
    expect(badgeForExtension('sh')).toBe(badgeForExtension('bash'));
  });

  /**
   * The fallback is the whole reason this may return nothing: a file the table
   * says nothing about gets a plain icon, not a blank square or a crash.
   */
  it('says nothing about an extension it does not know', () => {
    expect(badgeForExtension('xyz')).toBeNull();
    expect(badgeForExtension('')).toBeNull();
    expect(badgeForExtension(undefined)).toBeNull();
  });

  it('is looked up in lower case, as the caller provides it', () => {
    expect(badgeForExtension('PDF')).toBeNull();
    expect(badgeForExtension('js')).not.toBeNull();
  });
});

describe('the table as a whole', () => {
  const entries = BADGES.flatMap(([extensions, badge]) =>
    extensions.map((extension) => [extension, badge])
  );

  it('claims no extension twice', () => {
    const seen = new Set();
    const claimedTwice = [];
    for (const [extension] of entries) {
      if (seen.has(extension)) claimedTwice.push(extension);
      seen.add(extension);
    }

    expect(claimedTwice).toEqual([]);
  });

  it('gives every entry a label and two colours', () => {
    for (const [extension, badge] of entries) {
      expect(badge.label, extension).toMatch(/^[A-Z0-9]+$/);
      expect(badge.bg, extension).toMatch(/^#[0-9A-F]{6}$/i);
      expect(badge.fg, extension).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('names every extension in lower case, since that is how it is asked for', () => {
    for (const [extension] of entries) {
      expect(extension).toBe(extension.toLowerCase());
    }
  });
});
