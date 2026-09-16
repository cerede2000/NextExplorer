import { describe, it, expect } from 'vitest';

const {
  parseRecords,
  describeEntries,
  entryPathOf,
  levelOf,
} = require('../../src/services/archiveBrowseService');

/**
 * Reading an archive's table of contents, without unpacking it.
 *
 * Everything here works on the text `7z l -slt` prints, because that is where
 * the archive's own words arrive: a name in an archive is somebody else's
 * input, and this is the layer that decides what it is allowed to mean. What
 * it decides has to hold for names nobody would type — a path that climbs out
 * of the archive, a Windows drive letter, an equals sign in a filename, a
 * newline in one — so those are what most of this is about.
 */

/** The shape 7-Zip prints: its own header, ten dashes, then a block per entry. */
const listing = (blocks) =>
  [
    '7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov',
    '',
    'Listing archive: /volumes/Work/backup.zip',
    '',
    '--',
    'Path = /volumes/Work/backup.zip',
    'Type = zip',
    'Physical Size = 4096',
    '',
    '----------',
    ...blocks,
  ].join('\n');

const entry = (fields) =>
  Object.entries(fields)
    .map(([key, value]) => `${key} = ${value}`)
    .concat('')
    .join('\n');

describe('the records 7-Zip prints', () => {
  it('reads one record per entry, and none of its own header', () => {
    const records = parseRecords(
      listing([
        entry({ Path: 'notes.txt', Size: 12, Attributes: 'A_ -rw-r--r--' }),
        entry({ Path: 'docs', Size: 0, Attributes: 'D_ drwxr-xr-x' }),
      ])
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ Path: 'notes.txt', Size: '12' });
    expect(records.some((record) => String(record.Type) === 'zip')).toBe(false);
  });

  /** A filename may hold " = " as easily as any other characters. */
  it('splits a line at the first separator, not at every one', () => {
    const [record] = parseRecords(listing([entry({ Path: 'a = b = c.txt', Size: 1 })]));

    expect(record.Path).toBe('a = b = c.txt');
  });

  /**
   * A name with a newline in it is printed raw, so its second half arrives as
   * a line with no key at all. Dropped, it would leave a truncated name that
   * reads like a different file — and that file is the one a read would go
   * looking for.
   */
  it('keeps a name that runs onto the next line', () => {
    const [record] = parseRecords(
      listing([['Path = first\nsecond.txt', 'Size = 3', 'Attributes = A_', ''].join('\n')])
    );

    expect(record.Path).toBe('first\nsecond.txt');
    expect(record.Size).toBe('3');
  });

  it('has nothing to say about output with no entries in it', () => {
    expect(parseRecords('7-Zip (z) 26.03\n\nno archive here\n')).toEqual([]);
    expect(parseRecords('')).toEqual([]);
  });
});

describe('where an entry is allowed to be', () => {
  it.each([
    ['docs/report.txt', 'docs/report.txt'],
    ['./docs/report.txt', 'docs/report.txt'],
    ['docs//report.txt', 'docs/report.txt'],
    ['docs\\report.txt', 'docs/report.txt'],
    ['/docs/report.txt', 'docs/report.txt'],
  ])('reads %j as %j', (written, expected) => {
    expect(entryPathOf(written)).toBe(expected);
  });

  /**
   * The names a crafted archive carries. None of them is a place inside the
   * archive, and none of them is ever handed back as one.
   */
  it.each([
    ['../../etc/passwd'],
    ['docs/../../etc/passwd'],
    ['..'],
    ['C:/Windows/System32'],
    ['c:\\Windows'],
    [''],
    ['/'],
    ['.'],
  ])('refuses %j', (written) => {
    expect(entryPathOf(written)).toBeNull();
  });

  it('refuses what is not a string at all', () => {
    expect(entryPathOf(undefined)).toBeNull();
    expect(entryPathOf(42)).toBeNull();
  });
});

describe('what an archive says about itself', () => {
  it('reports each entry with its size, its date and whether it is a folder', () => {
    const { entries } = describeEntries(
      listing([
        entry({
          Path: 'docs/report.txt',
          Size: 4096,
          Modified: '2026-09-16 11:22:33',
          Attributes: 'A_ -rw-r--r--',
        }),
        entry({
          Path: 'docs',
          Size: 0,
          Modified: '2026-09-16 11:22:30',
          Attributes: 'D_ drwxr-xr-x',
        }),
      ])
    );

    expect(entries).toEqual([
      {
        path: 'docs/report.txt',
        isDirectory: false,
        size: 4096,
        modified: '2026-09-16 11:22:33',
        encrypted: false,
      },
      {
        path: 'docs',
        isDirectory: true,
        size: 0,
        modified: '2026-09-16 11:22:30',
        encrypted: false,
      },
    ]);
  });

  it('reads a folder from either of the two ways 7-Zip says so', () => {
    const { entries } = describeEntries(
      listing([
        entry({ Path: 'by-attribute', Attributes: 'D_ drwxr-xr-x' }),
        entry({ Path: 'by-flag', Folder: '+', Attributes: '' }),
      ])
    );

    expect(entries.map((item) => item.isDirectory)).toEqual([true, true]);
  });

  it('marks an entry whose contents are encrypted', () => {
    const { entries } = describeEntries(
      listing([entry({ Path: 'secret.txt', Size: 10, Encrypted: '+', Attributes: 'A_' })])
    );

    expect(entries[0].encrypted).toBe(true);
  });

  it('says nothing rather than something wrong about a size or a date it cannot read', () => {
    const { entries } = describeEntries(
      listing([entry({ Path: 'odd.txt', Size: 'huge', Modified: 'yesterday', Attributes: 'A_' })])
    );

    expect(entries[0]).toMatchObject({ size: null, modified: null });
  });

  /** Counted rather than shown: what cannot be somewhere is not shown as somewhere. */
  it('leaves out the entries that point outside the archive, and counts them', () => {
    const { entries, outside } = describeEntries(
      listing([
        entry({ Path: '../../etc/passwd', Size: 1, Attributes: 'A_' }),
        entry({ Path: 'C:/Windows/notepad.exe', Size: 2, Attributes: 'A_' }),
        entry({ Path: 'safe.txt', Size: 3, Attributes: 'A_' }),
      ])
    );

    expect(entries.map((item) => item.path)).toEqual(['safe.txt']);
    expect(outside).toBe(2);
  });
});

describe('one level of an archive', () => {
  const entries = [
    { path: 'notes.txt', isDirectory: false, size: 10, modified: null, encrypted: false },
    { path: 'docs/report.txt', isDirectory: false, size: 20, modified: null, encrypted: false },
    { path: 'docs/deep/inner.txt', isDirectory: false, size: 30, modified: null, encrypted: false },
    {
      path: 'photos',
      isDirectory: true,
      size: 0,
      modified: '2026-01-01 00:00:00',
      encrypted: false,
    },
  ];

  it('shows the folders and files of the top, and nothing from below it', () => {
    const level = levelOf(entries, '');

    expect(level.entries.map((item) => `${item.name}${item.isDirectory ? '/' : ''}`)).toEqual([
      'docs/',
      'photos/',
      'notes.txt',
    ]);
  });

  /**
   * A zip of `docs/report.txt` may hold that one entry and nothing else: the
   * folder exists because something is in it, not because it was written down.
   */
  it('shows a folder nothing in the archive names', () => {
    const level = levelOf([entries[1]], '');

    expect(level.entries).toEqual([
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        size: null,
        modified: null,
        encrypted: false,
      },
    ]);
  });

  it('prefers what the archive says about a folder to what it works out', () => {
    const level = levelOf(entries, '');
    const photos = level.entries.find((item) => item.name === 'photos');

    expect(photos.modified).toBe('2026-01-01 00:00:00');
  });

  it('goes down a level without showing the level below that', () => {
    const level = levelOf(entries, 'docs');

    expect(level.entries.map((item) => item.name)).toEqual(['deep', 'report.txt']);
    expect(level.entries.find((item) => item.name === 'deep').path).toBe('docs/deep');
  });

  it('knows a folder that is only an entry of its own', () => {
    expect(levelOf(entries, 'photos').exists).toBe(true);
    expect(levelOf(entries, 'photos').entries).toEqual([]);
  });

  it('does not invent a level that is not there', () => {
    expect(levelOf(entries, 'nowhere').exists).toBe(false);
  });

  /** `doc` is not `docs`, however much of it is a prefix. */
  it('does not take a folder for one whose name it begins', () => {
    expect(levelOf(entries, 'doc').exists).toBe(false);
  });
});
