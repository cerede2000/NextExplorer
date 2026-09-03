import { describe, expect, it } from 'vitest';

import { getKindLabel } from './fileKinds';

/**
 * The words in the "Kind" column, and in the info panel.
 *
 * Nine lookup tables and a fallback chain, at 33%. What is worth testing is not
 * the tables — a wrong label for `.flac` is a typo somebody will report — but
 * the chain underneath them, because that is what every unlisted extension goes
 * through and there are far more of those than listed ones.
 *
 * The order in that chain carries meaning. A directory is answered before any
 * table is consulted, because `directory` is a kind and not an extension; an
 * unlisted kind becomes `XYZ file` rather than falling through to the name; and
 * only a file with no kind at all is read from its filename. Reordering any of
 * those produces labels that are wrong in a way nobody would think to check.
 */

const kind = (k, name = 'file') => getKindLabel({ kind: k, name });

describe('things that are not files', () => {
  it('calls a directory a folder, not a DIRECTORY file', () => {
    expect(kind('directory')).toBe('Folder');
  });

  it('calls a volume a volume', () => {
    expect(kind('volume')).toBe('Volume');
  });

  /** Answered before the tables, so a volume named `zip` is still a volume. */
  it('answers those two whatever the file is called', () => {
    expect(getKindLabel({ kind: 'directory', name: 'archive.zip' })).toBe('Folder');
    expect(getKindLabel({ kind: 'volume', name: 'photo.jpg' })).toBe('Volume');
  });
});

describe('a kind the tables know', () => {
  it.each([
    ['jpg', 'JPEG image'],
    ['png', 'PNG image'],
    ['mp4', 'MP4 video'],
    ['flac', 'FLAC audio'],
    ['zip', 'ZIP archive'],
    ['7z', '7z archive'],
    ['pdf', 'PDF document'],
    ['docx', 'Word document'],
    ['xlsx', 'Excel spreadsheet'],
    ['py', 'Python script'],
    ['woff2', 'Web font'],
    ['deb', 'Linux package'],
    ['sqlite', 'SQLite database'],
  ])('%s is a %s', (extension, label) => {
    expect(kind(extension)).toBe(label);
  });

  it('answers the same for an upper-case kind', () => {
    expect(kind('JPG')).toBe('JPEG image');
    expect(kind('PDF')).toBe('PDF document');
  });

  /** Two extensions for one thing must give one answer, not two. */
  it.each([
    ['jpg', 'jpeg'],
    ['doc', 'docx'],
    ['md', 'markdown'],
    ['htm', 'html'],
    ['tif', 'tiff'],
  ])('gives %s and %s the same label', (a, b) => {
    expect(kind(a)).toBe(kind(b));
  });
});

describe('a kind no table lists', () => {
  it('says so in upper case rather than giving up', () => {
    expect(kind('xyz')).toBe('XYZ file');
    expect(kind('parquet')).toBe('PARQUET file');
  });

  /**
   * The kind wins over the name. A server that reported `webp` for a file
   * called `photo.jpg` knows something the filename does not.
   */
  it('trusts the kind over the filename', () => {
    expect(getKindLabel({ kind: 'webp', name: 'photo.jpg' })).toBe('WebP image');
  });
});

describe('a file with no kind at all', () => {
  /**
   * Note what this branch does *not* do: it never consults the lookup tables.
   * So `notes.md` reads as "MD file" here and "Markdown document" the moment
   * the listing supplies a kind — the same file, two labels, depending on which
   * path reached the column. Real, minor, and pinned rather than fixed: the
   * fallback exists for files the server did not classify, and quietly widening
   * it would change what several screens display. Recorded in TODO.md.
   */
  it('reads the extension off the name, generically', () => {
    expect(getKindLabel({ name: 'notes.md' })).toBe('MD file');
    expect(getKindLabel({ name: 'archive.parquet' })).toBe('PARQUET file');
  });

  it('takes the last extension of several', () => {
    expect(getKindLabel({ name: 'backup.tar.gz' })).toBe('GZ file');
  });

  it('upper-cases it whatever case the name used', () => {
    expect(getKindLabel({ name: 'PHOTO.jpg' })).toBe('JPG file');
  });

  it('says simply File when there is no extension either', () => {
    expect(getKindLabel({ name: 'LICENSE' })).toBe('File');
    expect(getKindLabel({ name: '' })).toBe('File');
  });

  /** A dotfile is a hidden name, not an extension: `.gitignore` is not a GITIGNORE file. */
  it('does not read a leading dot as an extension', () => {
    expect(getKindLabel({ name: '.gitignore' })).toBe('File');
  });

  it('does not read a trailing dot as one either', () => {
    expect(getKindLabel({ name: 'notes.' })).toBe('File');
  });
});

describe('nothing to describe', () => {
  it('says nothing rather than File', () => {
    expect(getKindLabel(null)).toBe('');
    expect(getKindLabel(undefined)).toBe('');
  });

  it('says File for an item with neither kind nor name', () => {
    expect(getKindLabel({})).toBe('File');
  });
});
