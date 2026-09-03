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

describe('a kind the server could not work out', () => {
  /**
   * The listing sends the literal string `unknown` for a file with no extension
   * and for one whose extension is too long to be plausible. That is a statement
   * about what the server managed, not something to show anybody — it used to
   * reach the column as "UNKNOWN file", which is what a LICENSE and a Makefile
   * read as.
   */
  it.each(['LICENSE', 'Makefile', 'CHANGELOG'])('says simply File for %s', (name) => {
    expect(getKindLabel({ kind: 'unknown', name })).toBe('File');
  });

  /** Falling through to the name gets a real answer where there is one. */
  it('falls back to the filename, through the same tables', () => {
    expect(getKindLabel({ kind: 'unknown', name: 'notes.md' })).toBe('Markdown document');
    expect(getKindLabel({ kind: 'unknown', name: 'photo.JPG' })).toBe('JPEG image');
  });

  /**
   * The server calls an implausibly long extension `unknown` on purpose.
   * Reading it off the name anyway would put its judgement straight back.
   */
  it('does not resurrect an extension the server rejected as too long', () => {
    expect(getKindLabel({ kind: 'unknown', name: 'archive.superlongextension' })).toBe('File');
  });
});

describe('a file with no kind at all', () => {
  /**
   * The same table lookup as a kind gets. It did not used to: a file arriving
   * without a kind read as "MD file" where the same file with one read as
   * "Markdown document" — one file, two labels, depending on which screen asked.
   */
  it('reads the extension off the name and looks it up', () => {
    expect(getKindLabel({ name: 'notes.md' })).toBe('Markdown document');
  });

  it('still names an extension no table lists', () => {
    expect(getKindLabel({ name: 'archive.parquet' })).toBe('PARQUET file');
  });

  it('takes the last extension of several', () => {
    expect(getKindLabel({ name: 'backup.tar.gz' })).toBe('GZip archive');
  });

  it('reads it whatever case the name used', () => {
    expect(getKindLabel({ name: 'PHOTO.jpg' })).toBe('JPEG image');
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
