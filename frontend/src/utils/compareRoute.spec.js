import { describe, expect, it, vi } from 'vitest';

/**
 * Where a comparison is.
 *
 * Two or three paths in the query rather than in the path, because a comparison is
 * not *at* a place — it is about several of them. A query also survives paths with
 * slashes in them without anybody having to invent a separator a file name cannot
 * contain, which is a thing no separator is.
 */

vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/config/compare', () => ({ MIN_COMPARED: 2, MAX_COMPARED: 3 }));

import { comparedPaths, comparedSides, compareRoute } from './compareRoute';

describe('the address of a comparison', () => {
  it('carries the two paths it is about', () => {
    expect(compareRoute(['Docs/a.txt', 'Docs/b.txt'])).toEqual({
      path: '/compare',
      query: { paths: ['Docs/a.txt', 'Docs/b.txt'] },
    });
  });

  it('carries three when there are three', () => {
    expect(compareRoute(['a.txt', 'b.txt', 'c.txt']).query.paths).toHaveLength(3);
  });

  it('keeps the order they were given in', () => {
    expect(compareRoute(['z.txt', 'a.txt']).query.paths).toEqual(['z.txt', 'a.txt']);
  });

  /** A file against itself is not a comparison. */
  it('is nothing for the same file twice', () => {
    expect(compareRoute(['Docs/a.txt', 'Docs/a.txt'])).toBeNull();
  });

  it('is nothing for one file, and nothing for four', () => {
    expect(compareRoute(['a.txt'])).toBeNull();
    expect(compareRoute(['a.txt', 'b.txt', 'c.txt', 'd.txt'])).toBeNull();
  });

  it('is nothing for no files at all', () => {
    expect(compareRoute([])).toBeNull();
    expect(compareRoute(null)).toBeNull();
  });

  it('ignores a path that is nothing but slashes', () => {
    expect(compareRoute(['a.txt', '/', ''])).toBeNull();
  });
});

describe('the paths a comparison address names', () => {
  it('reads several, as a router hands a repeated parameter over', () => {
    expect(comparedPaths({ paths: ['Docs/a.txt', 'Docs/b.txt'] })).toEqual([
      'Docs/a.txt',
      'Docs/b.txt',
    ]);
  });

  /** One arrives as a string, not an array of one: both are read the same way. */
  it('reads one written as a string', () => {
    expect(comparedPaths({ paths: 'Docs/a.txt' })).toEqual(['Docs/a.txt']);
  });

  it('reads nothing from an address with no paths on it', () => {
    expect(comparedPaths({})).toEqual([]);
    expect(comparedPaths(null)).toEqual([]);
  });

  it('drops a repeat, so a hand-written address cannot compare a file with itself', () => {
    expect(comparedPaths({ paths: ['a.txt', 'a.txt', 'b.txt'] })).toEqual(['a.txt', 'b.txt']);
  });

  it('takes no more than a comparison can hold', () => {
    expect(comparedPaths({ paths: ['a', 'b', 'c', 'd', 'e'] })).toEqual(['a', 'b', 'c']);
  });

  it('ignores anything in the query that is not a path', () => {
    expect(comparedPaths({ paths: [null, 42, 'a.txt', 'b.txt'] })).toEqual(['a.txt', 'b.txt']);
  });
});

/**
 * A file against one of its own earlier versions.
 *
 * Two parallel lists rather than one clever string, because the obvious clever string
 * needs a separator a file name cannot contain, and there is no such character.
 * Position is the join: the version at a place belongs to the path at that place.
 */
/**
 * Inside a share, a comparison is one of the share's own pages.
 *
 * `/compare` asks for an account, so the Versions panel's own offer — this
 * version against the file as it is now — sent a visitor with no account to the
 * sign-in screen. Everything a visitor sees is `/share/<token>/…`, and this is
 * no exception.
 */
describe('a comparison inside a share', () => {
  it("is at the share's own address", () => {
    expect(
      compareRoute([{ path: 'share/TOKEN/notes.txt', versionId: 'v7' }, 'share/TOKEN/notes.txt'])
    ).toEqual({
      path: '/share/TOKEN/compare',
      query: {
        paths: ['share/TOKEN/notes.txt', 'share/TOKEN/notes.txt'],
        versions: ['v7', ''],
      },
    });
  });

  it("keeps the application's address where no side is in a share", () => {
    expect(compareRoute(['Docs/a.txt', 'Docs/b.txt']).path).toBe('/compare');
  });

  /**
   * Somebody with an account comparing a shared file against one of their own is
   * not inside one share, and the share's prefix would be the wrong place for it:
   * the other side is not in the share and is not reachable under it.
   */
  it('keeps it too where the sides are not all in the same share', () => {
    expect(compareRoute(['share/TOKEN/notes.txt', 'Docs/mine.txt']).path).toBe('/compare');
    expect(compareRoute(['share/ONE/a.txt', 'share/TWO/a.txt']).path).toBe('/compare');
  });
});

describe('a comparison with an earlier version', () => {
  it('carries which version each side is', () => {
    expect(compareRoute([{ path: 'Docs/a.txt', versionId: 'v7' }, { path: 'Docs/a.txt' }])).toEqual(
      {
        path: '/compare',
        query: { paths: ['Docs/a.txt', 'Docs/a.txt'], versions: ['v7', ''] },
      }
    );
  });

  /** A file against itself is nothing; a file against its own past is a comparison. */
  it('allows the same path twice when one of them is a version', () => {
    expect(compareRoute([{ path: 'a.txt', versionId: 'v7' }, 'a.txt'])).not.toBeNull();
    expect(compareRoute(['a.txt', 'a.txt'])).toBeNull();
  });

  it('leaves the versions off an address where no side is one', () => {
    expect(compareRoute(['a.txt', 'b.txt']).query.versions).toBeUndefined();
  });

  it('reads the sides back, each with its own version', () => {
    expect(comparedSides({ paths: ['a.txt', 'a.txt'], versions: ['v7', ''] })).toEqual([
      { path: 'a.txt', versionId: 'v7' },
      { path: 'a.txt', versionId: '' },
    ]);
  });

  it('reads a side with no version as the file as it is now', () => {
    expect(comparedSides({ paths: ['a.txt', 'b.txt'] })).toEqual([
      { path: 'a.txt', versionId: '' },
      { path: 'b.txt', versionId: '' },
    ]);
  });

  /** The position is the join, and a join with one half missing joins nothing. */
  it('ignores a version with no path beside it', () => {
    expect(comparedSides({ paths: ['a.txt'], versions: ['', 'v7'] })).toEqual([
      { path: 'a.txt', versionId: '' },
    ]);
  });

  it('drops a side that repeats both the path and the version', () => {
    expect(
      comparedSides({ paths: ['a.txt', 'a.txt', 'b.txt'], versions: ['v7', 'v7', ''] })
    ).toEqual([
      { path: 'a.txt', versionId: 'v7' },
      { path: 'b.txt', versionId: '' },
    ]);
  });
});
